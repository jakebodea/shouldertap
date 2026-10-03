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
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join(APP_NAME);
    }
    // Running on a Mac for development: apart from the Mac app's own folders.
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join("Library/Application Support/Shouldertap Windows Dev")
}
