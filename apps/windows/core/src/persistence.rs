//! Where a computer keeps its pairing, like ShouldertapCore/LocalPersistence.swift.
//! The credential lives in a `CredentialVault` when one is given (Windows
//! Credential Manager) and otherwise in an owner-only file; unsent
//! acknowledgements live in a JSON file beside it.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::models::TapResponse;
use crate::store::ReceiverPersistence;

/// Somewhere safer than a file to keep the credential.
pub trait CredentialVault: Send + Sync {
    fn read(&self) -> Option<String>;
    fn write(&self, token: &str) -> Result<(), String>;
    fn delete(&self);
}

pub struct LocalPersistence {
    directory: PathBuf,
    vault: Option<Box<dyn CredentialVault>>,
}

impl LocalPersistence {
    pub fn new(directory: PathBuf, vault: Option<Box<dyn CredentialVault>>) -> Self {
        Self { directory, vault }
    }

    fn credential_path(&self) -> PathBuf {
        self.directory.join("credential.secret")
    }

    fn acks_path(&self) -> PathBuf {
        self.directory.join("pending-acks.json")
    }

    fn file_credential(&self) -> Option<String> {
        let token = fs::read_to_string(self.credential_path()).ok()?;
        let token = token.trim();
        (!token.is_empty()).then(|| token.to_string())
    }

    fn write_file(&self, name: PathBuf, contents: &[u8]) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        // Write then rename, so a crash never leaves half a file.
        let temporary = name.with_extension("tmp");
        fs::write(&temporary, contents).map_err(|error| error.to_string())?;
        restrict(&temporary);
        fs::rename(&temporary, &name).map_err(|error| error.to_string())
    }

    fn delete_file(&self) {
        let _ = fs::remove_file(self.credential_path());
    }
}

impl ReceiverPersistence for LocalPersistence {
    fn load_credential(&self) -> Option<String> {
        let Some(vault) = &self.vault else {
            return self.file_credential();
        };
        if let Some(token) = vault.read() {
            return Some(token);
        }
        let token = self.file_credential()?;
        // Migrate; the file goes only once the vault holds the credential.
        if vault.write(&token).is_ok() && vault.read().as_deref() == Some(token.as_str()) {
            self.delete_file();
        }
        Some(token)
    }

    fn save_credential(&self, token: &str) -> Result<(), String> {
        match &self.vault {
            Some(vault) => {
                vault.write(token)?;
                self.delete_file();
                Ok(())
            }
            None => self.write_file(self.credential_path(), token.as_bytes()),
        }
    }

    fn delete_credential(&self) {
        if let Some(vault) = &self.vault {
            vault.delete();
        }
        self.delete_file();
    }

    fn load_pending_acks(&self) -> BTreeMap<String, TapResponse> {
        fs::read(self.acks_path())
            .ok()
            .and_then(|json| serde_json::from_slice(&json).ok())
            .unwrap_or_default()
    }

    fn save_pending_acks(&self, acks: &BTreeMap<String, TapResponse>) {
        if acks.is_empty() {
            let _ = fs::remove_file(self.acks_path());
        } else if let Ok(json) = serde_json::to_vec(acks) {
            let _ = self.write_file(self.acks_path(), &json);
        }
    }
}

/// Owner-only on Unix; on Windows the file inherits the per-user profile's ACL.
fn restrict(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}
