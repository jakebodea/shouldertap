//! Where this computer connects: dev builds (`cargo run`) use the local
//! `alchemy dev` stack, release builds production (domains.ts at the repo
//! root). Dev builds can point elsewhere with SHOULDERTAP_SERVER_URL and
//! SHOULDERTAP_WEB_URL, and keep their own pairing, so testing never touches
//! the installed app's.

use std::path::PathBuf;

use shouldertap_core::Endpoints;

/// A `cargo build` without `--release` (build.rs sets `dev_build`).
pub const DEV: bool = cfg!(dev_build);

pub const APP_ID: &str = if DEV {
    "app.shouldertap.windows.debug"
} else {
    "app.shouldertap.windows"
};
pub const APP_NAME: &str = if DEV { "Shouldertap Debug" } else { "Shouldertap" };
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where Windows builds are published (scripts/release-windows.sh).
pub const DOWNLOADS_URL: &str = "https://download.shouldertap.app/windows";

pub fn endpoints() -> Endpoints {
    if DEV {
        if verification_run().is_some() {
            return Endpoints {
                server: std::env::var("SHOULDERTAP_SERVER_URL").expect("Verification requires SHOULDERTAP_SERVER_URL"),
                web: std::env::var("SHOULDERTAP_WEB_URL").expect("Verification requires SHOULDERTAP_WEB_URL"),
            };
        }
        Endpoints {
            server: std::env::var("SHOULDERTAP_SERVER_URL").unwrap_or_else(|_| "http://localhost:3000".into()),
            web: std::env::var("SHOULDERTAP_WEB_URL").unwrap_or_else(|_| "http://localhost:3001".into()),
        }
    } else {
        Endpoints {
            server: "https://api.shouldertap.app".into(),
            web: "https://shouldertap.app".into(),
        }
    }
}

/// `%LocalAppData%\Shouldertap` (or `Shouldertap Debug`): pending answers and
/// preferences. The credential itself is in Credential Manager.
pub fn data_dir() -> PathBuf {
    let base = if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        PathBuf::from(local).join(APP_NAME)
    } else {
        // Running on a Mac for development: apart from the Mac app's own folders.
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        home.join("Library/Application Support/Shouldertap Windows Dev")
    };
    match verification_run() {
        Some(run) => base.join("Verification").join(run),
        None => base,
    }
}

fn verification_run() -> Option<String> {
    if !DEV {
        return None;
    }
    std::env::var("SHOULDERTAP_VERIFY_RUN").ok().map(|run| {
        assert!(valid_run_id(&run), "Invalid SHOULDERTAP_VERIFY_RUN");
        run
    })
}

fn valid_run_id(run: &str) -> bool {
    !run.is_empty() && run.len() <= 100 && run.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Credential Manager targets and the process mutex must isolate together.
#[cfg(windows)]
pub fn instance_id() -> String {
    match verification_run() {
        Some(run) => format!("{APP_ID}.verify.{run}"),
        None => APP_ID.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::valid_run_id;

    #[test]
    fn accepts_launcher_ids_and_rejects_path_traversal() {
        assert!(valid_run_id("verify-a1b2c3-42"));
        for invalid in ["", "../other", "a/b", "a\\b", "two runs", ".", "å"] {
            assert!(!valid_run_id(invalid), "accepted {invalid}");
        }
    }
}
