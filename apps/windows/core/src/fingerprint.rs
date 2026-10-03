//! Names a computer for its one free trial (`MachineFingerprint` in
//! packages/domain/src/contracts.ts) without revealing its hardware id: a
//! salted SHA-256, so the value can't be reversed or matched against
//! identifiers other apps derive from the same id. Same salts as the Mac.

use sha2::{Digest, Sha256};

/// Shipping builds.
pub const RELEASE_SALT: &str = "shouldertap-trial-v1:";
/// Debug builds, so testing setup doesn't use up the developer's own trial.
pub const DEBUG_SALT: &str = "shouldertap-trial-debug-v1:";

/// 64 lowercase hex characters, or None for an empty hardware id.
pub fn machine_fingerprint(hardware_id: &str, salt: &str) -> Option<String> {
    if hardware_id.is_empty() {
        return None;
    }
    let digest = Sha256::digest(format!("{salt}{hardware_id}").as_bytes());
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
