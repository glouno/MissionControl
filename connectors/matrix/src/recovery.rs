//! Offline, single-owner Matrix recovery. Never logs session or crypto material.
use crate::connector::{ConnectorConfig, atomic_private, private_text};
use serde_json::{Value, json};
use std::{fs, path::Path};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub fn permanent_identity(config: &ConnectorConfig) -> Result<Value> {
    let server = matrix_sdk::reqwest::Url::parse(&config.homeserver)?;
    if server.scheme() != "https" || !server.username().is_empty() || server.password().is_some() {
        return Err("Recovery requires credential-free HTTPS homeserver identity".into());
    }
    Ok(
        json!({"homeserver":server.as_str(),"user":config.own_user,"device":config.own_device,"room":config.room_id}),
    )
}
fn directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.file_type().is_symlink() || fs::canonicalize(path)? != path {
        return Err("Recovery directory must be canonical and regular".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err("Recovery directory must be private".into());
        }
    }
    Ok(())
}
fn make_private(path: &Path) -> Result<()> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == "writer.lock" {
            continue;
        }
        let from = entry.path();
        let to = target.join(entry.file_name());
        let meta = fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() || !(meta.is_dir() || meta.is_file()) {
            return Err("Matrix snapshot refuses redirected or non-regular entries".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if meta.uid() != fs::metadata(source)?.uid() || meta.permissions().mode() & 0o077 != 0 {
                return Err("Matrix snapshot entries must be private and owned".into());
            }
        }
        if meta.is_dir() {
            directory(&from)?;
            make_private(&to)?;
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&to, fs::Permissions::from_mode(0o600))?;
            }
        }
    }
    Ok(())
}
pub fn snapshot(config: &ConnectorConfig, destination: &Path) -> Result<()> {
    directory(&config.state_dir)?;
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    snapshot_owned(config, destination)
}
/// Coordinator keeps SDK/session ownership through every recovery-set copy.
pub fn held_snapshot(config: &ConnectorConfig, destination: &Path) -> Result<()> {
    use std::io::{Read, Write};
    directory(&config.state_dir)?;
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    snapshot_owned(config, destination)?;
    println!("{{\"snapshotPrepared\":true,\"ownershipHeld\":true}}");
    std::io::stdout().flush()?;
    // Parent releases through EOF. No commands or credential values on stdin.
    let mut byte = [0u8; 1];
    if std::io::stdin().read(&mut byte)? != 0 {
        return Err("Held snapshot accepts only release through EOF".into());
    }
    Ok(())
}
fn snapshot_owned(config: &ConnectorConfig, destination: &Path) -> Result<()> {
    directory(destination.parent().ok_or("Snapshot parent missing")?)?;
    if destination.starts_with(&config.state_dir) {
        return Err("Snapshot must be outside Matrix state".into());
    }
    require_sdk_databases(&config.state_dir)?;
    if config.controller_token_file.starts_with(&config.state_dir) {
        return Err("Controller credential must live outside the Matrix SDK state store".into());
    }
    let identity = permanent_identity(config)?;
    let recorded: Value =
        serde_json::from_str(&private_text(&config.state_dir.join("identity.json"))?)?;
    if recorded != identity {
        return Err("Matrix snapshot permanent identity differs".into());
    }
    let session: matrix_sdk::authentication::matrix::MatrixSession =
        serde_json::from_str(&private_text(&config.session_file)?)?;
    if session.meta.user_id != config.own_user || session.meta.device_id != config.own_device {
        return Err("Matrix snapshot session identity differs".into());
    }
    let passphrase = private_text(&config.passphrase_file)?;
    make_private(destination)?;
    let result = (|| {
        let state = destination.join("store");
        make_private(&state)?;
        copy_tree(&config.state_dir, &state)?;
        atomic_private(
            &destination.join("session.json"),
            &serde_json::to_vec(&session)?,
        )?;
        atomic_private(&destination.join("store-passphrase"), passphrase.as_bytes())?;
        atomic_private(
            &destination.join("recovery-identity.json"),
            &serde_json::to_vec(&identity)?,
        )?;
        Ok(())
    })();
    if result.is_err() {
        fs::remove_dir_all(destination)?;
    }
    result
}
/// Opens encrypted SDK stores offline under the restored identity; no sync/login.
pub async fn inspect(config: &ConnectorConfig) -> Result<Value> {
    directory(&config.state_dir)?;
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    require_sdk_databases(&config.state_dir)?;
    let recorded: Value =
        serde_json::from_str(&private_text(&config.state_dir.join("identity.json"))?)?;
    if recorded != permanent_identity(config)? {
        return Err("Matrix recovery identity mismatch".into());
    }
    let session: matrix_sdk::authentication::matrix::MatrixSession =
        serde_json::from_str(&private_text(&config.session_file)?)?;
    if session.meta.user_id != config.own_user || session.meta.device_id != config.own_device {
        return Err("Matrix recovery session mismatch".into());
    }
    let client = crate::restore_client(
        &config.homeserver,
        &config.state_dir,
        &private_text(&config.passphrase_file)?,
        session,
    )
    .await?;
    let device = client
        .encryption()
        .get_own_device()
        .await?
        .ok_or("Restored own device missing")?;
    Ok(
        json!({"inspected":true,"crossSigned":device.is_verified_with_cross_signing(),"liveQualified":false}),
    )
}
fn require_sdk_databases(root: &Path) -> Result<()> {
    for name in ["matrix-sdk-state.sqlite3", "matrix-sdk-crypto.sqlite3"] {
        let meta = fs::symlink_metadata(root.join(name))?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 {
            return Err("Matrix recovery requires existing SDK state and crypto databases".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::{SessionMeta, SessionTokens, authentication::matrix::MatrixSession};
    #[tokio::test]
    async fn offline_snapshot_retains_sdk_keys_cursor_fault_and_refuses_an_active_writer() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let state = root.path().join("original");
        make_private(&state).unwrap();
        let config = ConnectorConfig {
            homeserver: "https://example.invalid".into(),
            room_id: "!synthetic:example.invalid".try_into().unwrap(),
            own_user: "@synthetic:example.invalid".try_into().unwrap(),
            own_device: "SYNTHETIC".into(),
            allowed_users: vec![],
            state_dir: state.clone(),
            session_file: root.path().join("session.json"),
            passphrase_file: root.path().join("passphrase"),
            controller_url: "http://127.0.0.1:43201".into(),
            controller_token_file: root.path().join("controller-token"),
        };
        let session = MatrixSession {
            meta: SessionMeta {
                user_id: config.own_user.clone(),
                device_id: config.own_device.clone(),
            },
            tokens: SessionTokens {
                access_token: "synthetic-not-a-real-token".into(),
                refresh_token: None,
            },
        };
        atomic_private(&config.session_file, &serde_json::to_vec(&session).unwrap()).unwrap();
        atomic_private(&config.passphrase_file, b"synthetic-passphrase").unwrap();
        atomic_private(
            &state.join("identity.json"),
            &serde_json::to_vec(&permanent_identity(&config).unwrap()).unwrap(),
        )
        .unwrap();
        atomic_private(
            &state.join("inbox.json"),
            br#"{"cursor":"synthetic-replay","entries":[],"trust_fault":true}"#,
        )
        .unwrap();
        let owner = crate::StoreOwner::acquire(&state).unwrap();
        let client =
            crate::restore_client(&config.homeserver, &state, "synthetic-passphrase", session)
                .await
                .unwrap();
        let own = client.encryption().get_own_device().await.unwrap().unwrap();
        let keys = format!("{:?}", own.keys());
        drop(own);
        drop(client);
        assert!(snapshot(&config, &root.path().join("locked")).is_err());
        drop(owner);
        // The production wrapper sets restrictive umask before the companion.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in fs::read_dir(&state).unwrap() {
                let path = entry.unwrap().path();
                if path.is_file() {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
                }
            }
        }
        let restored = root.path().join("snapshot");
        snapshot(&config, &restored).unwrap();
        assert!(!restored.join("store/writer.lock").exists());
        assert_eq!(
            private_text(&restored.join("store/inbox.json")).unwrap(),
            private_text(&state.join("inbox.json")).unwrap()
        );
        let next = ConnectorConfig {
            state_dir: restored.join("store"),
            session_file: restored.join("session.json"),
            passphrase_file: restored.join("store-passphrase"),
            ..config.clone()
        };
        assert_eq!(inspect(&next).await.unwrap()["inspected"], true);
        let session = serde_json::from_str(&private_text(&next.session_file).unwrap()).unwrap();
        let client = crate::restore_client(
            &next.homeserver,
            &next.state_dir,
            "synthetic-passphrase",
            session,
        )
        .await
        .unwrap();
        assert_eq!(
            format!(
                "{:?}",
                client
                    .encryption()
                    .get_own_device()
                    .await
                    .unwrap()
                    .unwrap()
                    .keys()
            ),
            keys
        );
        drop(client);
        let wrong = ConnectorConfig {
            own_device: "OTHER".into(),
            ..next
        };
        assert!(inspect(&wrong).await.is_err());
        assert!(snapshot(&config, &restored).is_err());
        if let Ok(destination) = std::env::var("MISSIONCONTROL_MATRIX_RECOVERY_FIXTURE") {
            let fixture = std::path::PathBuf::from(destination);
            directory(&fixture).unwrap();
            snapshot(&config, &fixture.join("synthetic")).unwrap();
            let fixture_config = ConnectorConfig {
                state_dir: fixture.join("synthetic/store"),
                session_file: fixture.join("synthetic/session.json"),
                passphrase_file: fixture.join("synthetic/store-passphrase"),
                ..config
            };
            let value = json!({"homeserver":fixture_config.homeserver,"room_id":fixture_config.room_id,"own_user":fixture_config.own_user,"own_device":fixture_config.own_device,"allowed_users":fixture_config.allowed_users,"state_dir":fixture_config.state_dir,"session_file":fixture_config.session_file,"passphrase_file":fixture_config.passphrase_file,"controller_url":fixture_config.controller_url,"controller_token_file":fixture_config.controller_token_file});
            atomic_private(
                &fixture.join("config.json"),
                &serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
    }
}
