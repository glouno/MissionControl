fn main() {
    // Apply before any SDK files are created; no other threads have been started.
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Matrix runtime initialization failed")
        .block_on(run());
}
async fn run() {
    let result = async {
        let mut args = std::env::args().skip(1);
        let first = args
            .next()
            .ok_or("Supply an external connector configuration file")?;
        let (action, path) = if [
            "snapshot",
            "snapshot-held",
            "inspect-store",
            "inspect-trust",
            "login",
            "refresh",
            "verify",
            "verify-user",
            "recover-trust",
        ]
        .contains(&first.as_str())
        {
            (first, args.next().ok_or("Supply external configuration")?)
        } else {
            ("run".to_owned(), first)
        };
        let supplied = std::path::PathBuf::from(path);
        if std::fs::symlink_metadata(&supplied)?
            .file_type()
            .is_symlink()
        {
            return Err("Connector config cannot be redirected".into());
        }
        let path = std::fs::canonicalize(supplied)?;
        let info = std::fs::symlink_metadata(&path)?;
        if !info.is_file() {
            return Err("Connector configuration must be regular".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if info.uid() != unsafe { libc::geteuid() } || info.permissions().mode() & 0o077 != 0 {
                return Err("Connector configuration must be private and owned".into());
            }
        }
        let mut config: missioncontrol_matrix::connector::ConnectorConfig =
            serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        let parent = path.parent().ok_or("Connector config parent missing")?;
        for location in [
            &mut config.state_dir,
            &mut config.session_file,
            &mut config.passphrase_file,
            &mut config.controller_token_file,
        ] {
            if location.is_relative() {
                *location = parent.join(&*location);
            }
        }
        if action == "login" {
            let password_file = args.next().ok_or("Supply a private password-file path")?;
            missioncontrol_matrix::setup::login(&config, std::path::Path::new(&password_file))
                .await?;
            return Ok::<(), Box<dyn std::error::Error + Send + Sync>>(());
        }
        if action == "refresh" {
            missioncontrol_matrix::setup::refresh(&config).await?;
            return Ok(());
        }
        if action == "inspect-trust" {
            println!(
                "{}",
                missioncontrol_matrix::setup::inspect_trust(&config).await?
            );
            return Ok(());
        }
        if action == "verify" {
            let device = args
                .next()
                .ok_or("Select an existing verification device")?;
            missioncontrol_matrix::setup::verify(&config, &device).await?;
            return Ok(());
        }
        if action == "verify-user" {
            let user = args.next().ok_or("Select an allowed operator account")?;
            let device = args.next().ok_or("Select the operator's signed device")?;
            missioncontrol_matrix::setup::verify_user(&config, &user, &device).await?;
            return Ok(());
        }
        if action == "recover-trust" {
            let confirmation = args
                .next()
                .ok_or("Explicit history-review confirmation required")?;
            missioncontrol_matrix::setup::recover_trust(&config, &confirmation).await?;
            return Ok(());
        }
        if action == "snapshot" || action == "snapshot-held" {
            let destination = args.next().ok_or("Supply a new snapshot directory")?;
            if action == "snapshot-held" {
                missioncontrol_matrix::recovery::held_snapshot(
                    &config,
                    std::path::Path::new(&destination),
                )?;
                return Ok(());
            }
            missioncontrol_matrix::recovery::snapshot(&config, std::path::Path::new(&destination))?;
            println!("{{\"snapshotPrepared\":true,\"encrypted\":false}}");
            return Ok::<(), Box<dyn std::error::Error + Send + Sync>>(());
        }
        if action == "inspect-store" {
            println!(
                "{}",
                missioncontrol_matrix::recovery::inspect(&config).await?
            );
            return Ok(());
        }
        missioncontrol_matrix::connector::run(config).await
    }
    .await;
    if result.is_err() {
        eprintln!(
            "Matrix connector stopped. Check private configuration, store ownership and verified identity; sensitive diagnostics are suppressed."
        );
        std::process::exit(1)
    }
}
