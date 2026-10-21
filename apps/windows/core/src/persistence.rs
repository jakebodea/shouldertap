//! Where a computer keeps its pairings, like ShouldertapCore/LocalPersistence.swift
//! and LocalSenderPersistence.swift. Secrets (the device credential, each
//! sender pairing's token) live in a `CredentialVault` when one is given
//! (Windows Credential Manager) and otherwise in owner-only files; unsent
//! acknowledgements and taps live in JSON files beside them.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::TapResponse;
use crate::sender::{OutgoingTap, SenderPairing, SenderPersistence};
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
        write_file(&self.directory, &name, contents)
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

/// A sender pairing's vault, by credential id: one entry per pairing, since
/// Credential Manager keeps only small secrets.
pub type SenderVaults = Box<dyn Fn(&str) -> Box<dyn CredentialVault> + Send + Sync>;

/// A PC's sender pairings: the list in `senders.secret` (owner-only), each
/// token in its own vault entry when vaults are given and in the list
/// otherwise. Outboxes aren't secret: `outbox-<credentialId>.json`.
pub struct LocalSenderPersistence {
    directory: PathBuf,
    vaults: Option<SenderVaults>,
}

impl LocalSenderPersistence {
    pub fn new(directory: PathBuf, vaults: Option<SenderVaults>) -> Self {
        Self { directory, vaults }
    }

    fn pairings_path(&self) -> PathBuf {
        self.directory.join("senders.secret")
    }

    fn outbox_path(&self, credential_id: &str) -> PathBuf {
        let safe: String = credential_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.directory.join(format!("outbox-{safe}.json"))
    }

    /// As saved: tokens are empty when they live in the vault.
    fn read_list(&self) -> Vec<SenderPairing> {
        fs::read(self.pairings_path())
            .ok()
            .and_then(|json| serde_json::from_slice(&json).ok())
            .unwrap_or_default()
    }

    fn write_list(&self, mut pairings: Vec<SenderPairing>) -> Result<(), String> {
        if pairings.is_empty() {
            let _ = fs::remove_file(self.pairings_path());
            return Ok(());
        }
        if self.vaults.is_some() {
            for pairing in &mut pairings {
                pairing.token.clear();
            }
        }
        let json = serde_json::to_vec(&pairings).map_err(|error| error.to_string())?;
        write_file(&self.directory, &self.pairings_path(), &json)
    }
}

impl SenderPersistence for LocalSenderPersistence {
    fn load_pairings(&self) -> Vec<SenderPairing> {
        self.read_list()
            .into_iter()
            .filter_map(|mut pairing| {
                if let Some(token) = self
                    .vaults
                    .as_ref()
                    .and_then(|vault| vault(&pairing.credential_id).read())
                {
                    pairing.token = token;
                }
                // A token the vault lost can't tap anyone.
                (!pairing.token.is_empty()).then_some(pairing)
            })
            .collect()
    }

    fn save_pairing(&self, pairing: &SenderPairing) -> Result<(), String> {
        if let Some(vault) = &self.vaults {
            vault(&pairing.credential_id).write(&pairing.token)?;
        }
        let mut pairings: Vec<SenderPairing> = self
            .read_list()
            .into_iter()
            .filter(|saved| saved.credential_id != pairing.credential_id)
            .collect();
        pairings.push(pairing.clone());
        self.write_list(pairings)
    }

    fn delete_pairing(&self, credential_id: &str) {
        if let Some(vault) = &self.vaults {
            vault(credential_id).delete();
        }
        let pairings = self
            .read_list()
            .into_iter()
            .filter(|saved| saved.credential_id != credential_id)
            .collect();
        let _ = self.write_list(pairings);
    }

    fn load_outbox(&self, credential_id: &str) -> Vec<OutgoingTap> {
        fs::read(self.outbox_path(credential_id))
            .ok()
            .and_then(|json| serde_json::from_slice(&json).ok())
            .unwrap_or_default()
    }

    fn save_outbox(&self, outbox: &[OutgoingTap], credential_id: &str) {
        let path = self.outbox_path(credential_id);
        if outbox.is_empty() {
            let _ = fs::remove_file(path);
        } else if let Ok(json) = serde_json::to_vec(outbox) {
            let _ = write_file(&self.directory, &path, &json);
        }
    }
}

/// Write then rename, so a crash never leaves half a file.
fn write_file(directory: &Path, name: &Path, contents: &[u8]) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temporary = name.with_extension("tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    restrict(&temporary);
    fs::rename(&temporary, name).map_err(|error| error.to_string())
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
