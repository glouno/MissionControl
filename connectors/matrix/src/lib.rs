//! Matrix SDK identity foundation. This is not yet an enabled human connector.
//! Command intake is gated on room/device trust and durable replay qualification.
use fs2::FileExt;
use matrix_sdk::{Client, authentication::matrix::MatrixSession};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};
pub mod connector;
pub mod recovery;
pub mod setup;

/// Advisory kernel lock is released on crash; an existing file is not a writer.
pub struct StoreOwner(File);
impl StoreOwner {
    pub fn acquire(directory: &Path) -> io::Result<Self> {
        let info = fs::symlink_metadata(directory)?;
        if info.file_type().is_symlink()
            || !info.is_dir()
            || fs::canonicalize(directory)? != directory
        {
            return Err(io::Error::other("Matrix state must be a regular directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            if info.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::other(
                    "Matrix store must be owned by the current user",
                ));
            }
            if info.permissions().mode() & 0o077 != 0 {
                return Err(io::Error::other("Matrix state permissions must be private"));
            }
        }
        let lock_path = directory.join("writer.lock");
        if lock_path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(io::Error::other("Matrix lock cannot be a symlink"));
        }
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(lock_path)?;
        file.try_lock_exclusive()?;
        Ok(Self(file))
    }
}
impl Drop for StoreOwner {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

/// Session and passphrase are supplied from private storage, never CLI arguments.
/// No login, device trust, room joins or key backup is performed implicitly.
pub async fn restore_client(
    homeserver: &str,
    directory: &Path,
    passphrase: &str,
    session: MatrixSession,
) -> Result<Client, Box<dyn std::error::Error + Send + Sync>> {
    let client = build_client(homeserver, directory, passphrase).await?;
    client.restore_session(session).await?;
    Ok(client)
}

pub async fn build_client(
    homeserver: &str,
    directory: &Path,
    passphrase: &str,
) -> Result<Client, Box<dyn std::error::Error + Send + Sync>> {
    Ok(Client::builder()
        .homeserver_url(homeserver)
        .sqlite_store(directory, Some(passphrase))
        .handle_refresh_tokens()
        .with_room_key_recipient_strategy(matrix_sdk_crypto::CollectStrategy::OnlyTrustedDevices)
        .with_decryption_settings(matrix_sdk_crypto::DecryptionSettings {
            sender_device_trust_requirement: matrix_sdk_crypto::TrustRequirement::CrossSigned,
        })
        .with_enable_share_history_on_invite(false)
        .build()
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::{
        SessionMeta, SessionTokens,
        ruma::{device_id, user_id},
    };

    fn session() -> MatrixSession {
        MatrixSession {
            meta: SessionMeta {
                user_id: user_id!("@synthetic:example.invalid").to_owned(),
                device_id: device_id!("SYNTHETIC").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "synthetic-not-a-real-token".into(),
                refresh_token: None,
            },
        }
    }
    #[tokio::test]
    async fn encrypted_sdk_identity_survives_restart_and_only_one_writer_acquires_store() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let owner = StoreOwner::acquire(directory.path()).unwrap();
        assert!(StoreOwner::acquire(directory.path()).is_err());
        let client = restore_client(
            "https://example.invalid",
            directory.path(),
            "synthetic-store-passphrase",
            session(),
        )
        .await
        .unwrap();
        let device = client.encryption().get_own_device().await.unwrap().unwrap();
        let keys = format!("{:?}", device.keys());
        assert_eq!(client.device_id().unwrap().as_str(), "SYNTHETIC");
        // The SDK locally trusts its own device. Cross-signing still requires
        // explicit verification and must not be inferred from that local trust.
        assert!(!device.is_verified_with_cross_signing());
        drop(device);
        drop(client);
        drop(owner);
        let _owner = StoreOwner::acquire(directory.path()).unwrap();
        let restored = restore_client(
            "https://example.invalid",
            directory.path(),
            "synthetic-store-passphrase",
            session(),
        )
        .await
        .unwrap();
        let device = restored
            .encryption()
            .get_own_device()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(format!("{:?}", device.keys()), keys);
        assert!(!device.is_verified_with_cross_signing());
    }
}
