//! Explicit private setup. No accounts, room joins or device trust are automatic.
use crate::connector::{ConnectorConfig, atomic_private, private_text, trusted_room};
use matrix_sdk::{
    Client,
    authentication::matrix::MatrixSession,
    config::{SyncSettings, SyncToken},
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub fn persist_session(client: &Client, path: &Path) -> Result<()> {
    let session = client
        .matrix_auth()
        .session()
        .ok_or("Matrix native session missing")?;
    atomic_private(path, &serde_json::to_vec(&session)?)
}
/// The SDK invokes save synchronously after refresh but ignores returned errors.
/// A separate fault latch therefore stops sync/traffic if durability fails.
pub fn install_session_callbacks(client: &Client, path: PathBuf) -> Result<Arc<AtomicBool>> {
    let fault = Arc::new(AtomicBool::new(false));
    let save_fault = fault.clone();
    let reload_path = path.clone();
    client.set_session_callbacks(
        Box::new(move |_| {
            let session: MatrixSession = serde_json::from_str(&private_text(&reload_path)?)?;
            Ok(session.tokens)
        }),
        Box::new(move |client| {
            if let Err(error) = persist_session(&client, &path) {
                save_fault.store(true, Ordering::SeqCst);
                return Err(error);
            }
            Ok(())
        }),
    )?;
    Ok(fault)
}
fn check_fault(fault: &AtomicBool) -> Result<()> {
    if fault.load(Ordering::SeqCst) {
        return Err("Session refresh was not durably saved; sensitive traffic stopped".into());
    }
    Ok(())
}
async fn operator_match(deadline: tokio::time::Instant) -> Result<bool> {
    // Blocking terminal input must not suspend the verification deadline.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut answer = String::new();
        let result = std::io::stdin()
            .read_line(&mut answer)
            .map(|_| answer.trim() == "MATCH");
        let _ = sender.send(result);
    });
    Ok(tokio::time::timeout_at(deadline, receiver).await???)
}
pub async fn session_client(config: &ConnectorConfig) -> Result<(Client, Arc<AtomicBool>)> {
    let identity = crate::recovery::permanent_identity(config)?;
    let recorded: serde_json::Value =
        serde_json::from_str(&private_text(&config.state_dir.join("identity.json"))?)?;
    if recorded != identity {
        return Err("Permanent Matrix identity changed; use separate state".into());
    }
    let session: MatrixSession = serde_json::from_str(&private_text(&config.session_file)?)?;
    if session.meta.user_id != config.own_user || session.meta.device_id != config.own_device {
        return Err("Session differs from permanent account/device".into());
    }
    let client = crate::restore_client(
        &config.homeserver,
        &config.state_dir,
        &private_text(&config.passphrase_file)?,
        session,
    )
    .await?;
    let fault = install_session_callbacks(&client, config.session_file.clone())?;
    Ok((client, fault))
}
pub async fn login(config: &ConnectorConfig, password_file: &Path) -> Result<()> {
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    crate::recovery::permanent_identity(config)?;
    if config.session_file.exists() || config.state_dir.join("identity.json").exists() {
        return Err("Login requires a fresh dedicated session; existing identity must be recovered separately".into());
    }
    if std::fs::read_dir(&config.state_dir)?
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().contains("sqlite"))
    {
        return Err("Login requires a fresh crypto store, never replacement credentials for retained crypto state".into());
    }
    let password = private_text(password_file)?;
    let client = crate::build_client(
        &config.homeserver,
        &config.state_dir,
        &private_text(&config.passphrase_file)?,
    )
    .await?;
    client
        .matrix_auth()
        .login_username(
            config.own_user.as_str(),
            password.trim_end_matches(['\r', '\n']),
        )
        .device_id(config.own_device.as_str())
        .initial_device_display_name("MissionControl")
        .request_refresh_token()
        .send()
        .await?;
    if client.user_id() != Some(config.own_user.as_ref())
        || client.device_id() != Some(config.own_device.as_ref())
    {
        return Err("Server login identity differs from configured permanent device".into());
    }
    persist_session(&client, &config.session_file)?;
    atomic_private(
        &config.state_dir.join("identity.json"),
        &serde_json::to_vec(&crate::recovery::permanent_identity(config)?)?,
    )?;
    println!(
        "{}",
        json!({"loggedIn":true,"verified":false,"qualification":"pending"})
    );
    Ok(())
}
pub async fn refresh(config: &ConnectorConfig) -> Result<()> {
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    let (client, fault) = session_client(config).await?;
    client.matrix_auth().refresh_access_token().await?;
    check_fault(&fault)?;
    persist_session(&client, &config.session_file)?;
    println!("{{\"refreshed\":true,\"qualification\":\"pending\"}}");
    Ok(())
}
/// Refresh the SDK's observed keys/signatures without granting device trust.
/// Offline store inspection may predate the peer's final signature upload.
pub async fn inspect_trust(config: &ConnectorConfig) -> Result<serde_json::Value> {
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    let (client, fault) = session_client(config).await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        client
            .sync_once(SyncSettings::default().token(SyncToken::NoToken))
            .await?;
        check_fault(&fault)?;
        // Request current server signatures through SDK validation, without
        // manually verifying an identity or importing any cross-signing secrets.
        client
            .encryption()
            .request_user_identity(&config.own_user)
            .await?;
        for user in &config.allowed_users {
            client.encryption().request_user_identity(user).await?;
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await??;
    check_fault(&fault)?;
    let own = client
        .encryption()
        .get_own_device()
        .await?
        .ok_or("Own device missing")?;
    let own_identity = client
        .encryption()
        .get_user_identity(&config.own_user)
        .await?;
    let mut operators = Vec::new();
    for user in &config.allowed_users {
        let identity = client.encryption().get_user_identity(user).await?;
        let devices = client.encryption().get_user_devices(user).await?;
        operators.push(json!({
            "identityVerified": identity.is_some_and(|identity| identity.is_verified()),
            "crossSignedDevices": devices.devices().filter(|device| device.is_verified_with_cross_signing()).count(),
        }));
    }
    persist_session(&client, &config.session_file)?;
    Ok(json!({
        "inspected": true,
        "online": true,
        "ownIdentityVerified": own_identity.is_some_and(|identity| identity.is_verified()),
        "ownDeviceCrossSigned": own.is_verified_with_cross_signing(),
        "operators": operators,
        "trustGrantedByInspection": false,
        "liveQualified": false,
    }))
}
/// Explicitly selected same-account device must already be verified by the operator.
pub async fn verify(config: &ConnectorConfig, device_id: &str) -> Result<()> {
    verify_peer(config, &config.own_user, device_id).await
}
pub async fn verify_user(config: &ConnectorConfig, user: &str, device_id: &str) -> Result<()> {
    let user: matrix_sdk::ruma::OwnedUserId = user.try_into()?;
    if !config.allowed_users.contains(&user) || user == config.own_user {
        return Err("Verification peer must be an explicitly allowed operator account".into());
    }
    verify_peer(config, &user, device_id).await
}
async fn verify_peer(
    config: &ConnectorConfig,
    user: &matrix_sdk::ruma::OwnedUserId,
    device_id: &str,
) -> Result<()> {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        return Err("Verification requires a private interactive terminal".into());
    }
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    let (client, fault) = session_client(config).await?;
    client
        .sync_once(SyncSettings::default().token(SyncToken::NoToken))
        .await?;
    check_fault(&fault)?;
    let device = client
        .encryption()
        .get_device(user, device_id.into())
        .await?
        .ok_or("Selected verification device is unknown")?;
    // A new connector has not verified its cross-signing identity yet. Require
    // the peer's signed device, then let explicit SAS establish identity trust.
    // The signature alone never authorizes application traffic.
    if !device.is_cross_signed_by_owner() {
        return Err("Selected operator device lacks its owner's cross-signing signature".into());
    }
    if user == &config.own_user && device.device_id() == config.own_device {
        return Err("Cannot verify against the connector's own device".into());
    }
    let request = device.request_verification().await?;
    println!("Accept the verification request on your selected existing device.");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let mut started = false;
    let mut confirmed = false;
    while tokio::time::Instant::now() < deadline {
        tokio::time::timeout(
            Duration::from_secs(25),
            client.sync_once(SyncSettings::default().timeout(Duration::from_secs(10))),
        )
        .await??;
        check_fault(&fault)?;
        if request.cancel_info().is_some() {
            return Err("Verification was cancelled".into());
        }
        if request.is_ready() && !started {
            request.start_sas().await?;
            started = true;
        }
        if let Some(sas) = client
            .encryption()
            .get_verification(user, request.flow_id())
            .await
            .and_then(|v| v.sas())
        {
            if sas.other_device().device_id() != device.device_id() || sas.other_user_id() != *user
            {
                sas.cancel().await?;
                return Err("Verification peer changed".into());
            }
            if !confirmed {
                if let Some(emoji) = sas.emoji() {
                    println!("Compare these symbols and descriptions on both devices:");
                    for e in emoji {
                        println!("{} {}", e.symbol, e.description);
                    }
                    println!(
                        "Type MATCH only after checking the selected device, or anything else to cancel:"
                    );
                    let matched = match operator_match(deadline).await {
                        Ok(matched) => matched,
                        Err(error) => {
                            let _ = sas.cancel().await;
                            return Err(error);
                        }
                    };
                    if !matched {
                        sas.cancel().await?;
                        return Err("Operator did not confirm matching verification".into());
                    }
                    sas.confirm().await?;
                    confirmed = true;
                }
            }
            if sas.is_done() {
                let own = client
                    .encryption()
                    .get_own_device()
                    .await?
                    .ok_or("Own device missing")?;
                if !own.is_verified_with_cross_signing() {
                    return Err(
                        "SAS finished without cross-signing evidence; intake remains disabled"
                            .into(),
                    );
                }
                let peer = client
                    .encryption()
                    .get_device(user, device_id.into())
                    .await?
                    .ok_or("Verified peer disappeared")?;
                if !peer.is_verified_with_cross_signing() {
                    return Err("SAS finished without trusted peer cross-signing evidence".into());
                }
                persist_session(&client, &config.session_file)?;
                println!("{{\"verified\":true,\"qualification\":\"live workflow still pending\"}}");
                return Ok(());
            }
        }
    }
    request.cancel().await?;
    Err("Verification timed out".into())
}
pub async fn recover_trust(config: &ConnectorConfig, confirmation: &str) -> Result<()> {
    if confirmation != "REVIEWED-ROOM-HISTORY" {
        return Err("Explicit reviewed-room-history confirmation required".into());
    }
    let _owner = crate::StoreOwner::acquire(&config.state_dir)?;
    let (client, fault) = session_client(config).await?;
    client
        .sync_once(SyncSettings::default().token(SyncToken::NoToken))
        .await?;
    check_fault(&fault)?;
    trusted_room(&client, config).await?;
    crate::connector::clear_reviewed_trust_fault(config)?;
    println!("{{\"trustFaultCleared\":true,\"historyReviewedByOperator\":true}}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn refreshed_native_session_is_atomically_saved_without_public_diagnostics() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let session = MatrixSession {
            meta: matrix_sdk::SessionMeta {
                user_id: matrix_sdk::ruma::user_id!("@synthetic:example.invalid").to_owned(),
                device_id: matrix_sdk::ruma::device_id!("SYNTHETIC").to_owned(),
            },
            tokens: matrix_sdk::SessionTokens {
                access_token: "synthetic".into(),
                refresh_token: Some("synthetic-refresh".into()),
            },
        };
        let client = crate::restore_client(
            "https://example.invalid",
            directory.path(),
            "synthetic-passphrase",
            session.clone(),
        )
        .await
        .unwrap();
        let path = directory.path().join("session.json");
        let fault = install_session_callbacks(&client, path.clone()).unwrap();
        persist_session(&client, &path).unwrap();
        let reopened: MatrixSession = serde_json::from_str(&private_text(&path).unwrap()).unwrap();
        assert_eq!(reopened.tokens.refresh_token, session.tokens.refresh_token);
        assert!(!fault.load(Ordering::SeqCst));
        let fault = AtomicBool::new(true);
        assert!(check_fault(&fault).is_err());
    }
}
