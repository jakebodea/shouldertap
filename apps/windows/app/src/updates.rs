//! Self-updates from the download bucket, the Windows counterpart of the Mac's
//! Sparkle feed. scripts/release-windows.sh publishes `windows/latest.json`
//! (`{version, url, sha256}`); a found update shows as a row in the menu,
//! like Sparkle's gentle reminders, and installs when clicked.

use std::time::Duration;

use gpui::{App, BorrowAppContext, Task};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config;
use crate::shell::Shell;

const FEED: &str = "latest.json";
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    /// The version a check found, until it's installed.
    pub available: Option<String>,
    pub checking: bool,
    pub installing: bool,
    /// The outcome of a check you asked for, or why an install failed.
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

pub struct Updates {
    /// What the last check found, for `install`.
    pub(crate) found: Option<Release>,
    _schedule: Option<Task<()>>,
}

impl Updates {
    /// Checks a minute after launch and every 6 hours. Dev builds don't.
    pub fn start(cx: &mut App) -> Self {
        crate::platform::clean_up_after_update();
        let schedule = (!config::DEV).then(|| {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_secs(60)).await;
                loop {
                    if cx.update(|cx| check(false, cx)).is_err() {
                        break;
                    }
                    cx.background_executor().timer(EVERY).await;
                }
            })
        });
        Self {
            found: None,
            _schedule: schedule,
        }
    }
}

/// A check you asked for ("Check for Updates…") says how it went.
pub fn check_now(cx: &mut App) {
    check(true, cx);
}

/// Downloads, checks and swaps in the update a check found, then restarts.
pub fn install(cx: &mut App) {
    let Some(release) = cx.global::<Shell>().updates.found.clone() else {
        return;
    };
    set_status(cx, |status| {
        status.installing = true;
        status.message = None;
    });
    let task = cx
        .background_executor()
        .spawn(async move { download_and_stage(&release) });
    cx.spawn(async move |cx| {
        let result = task.await;
        let _ = cx.update(|cx| match result {
            Ok(()) => {
                crate::platform::relaunch_updated();
                cx.quit();
            }
            Err(message) => set_status(cx, |status| {
                status.installing = false;
                status.message = Some(message);
            }),
        });
    })
    .detach();
}

fn check(asked: bool, cx: &mut App) {
    set_status(cx, |status| {
        status.checking = true;
        if asked {
            status.message = None;
        }
    });
    let task = cx.background_executor().spawn(async move { fetch_feed() });
    cx.spawn(async move |cx| {
        let result = task.await;
        let _ = cx.update(|cx| {
            let newer = result
                .as_ref()
                .ok()
                .filter(|release| is_newer(&release.version, config::VERSION))
                .cloned();
            cx.update_global::<Shell, _>(|shell, _| shell.updates.found = newer.clone());
            set_status(cx, |status| {
                status.checking = false;
                status.available = newer.as_ref().map(|release| release.version.clone());
                if asked {
                    status.message = Some(match (&result, &newer) {
                        (Err(_), _) => "Couldn't check for updates. Try again later.".into(),
                        (Ok(_), None) => format!("You're up to date ({}).", config::VERSION),
                        (Ok(_), Some(_)) => String::new(),
                    })
                    .filter(|message| !message.is_empty());
                }
            });
        });
    })
    .detach();
}

fn set_status(cx: &mut App, change: impl FnOnce(&mut Status)) {
    let model = cx.global::<Shell>().model.clone();
    model.update(cx, |model, cx| {
        change(&mut model.updates);
        cx.notify();
    });
}

fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn fetch_feed() -> Result<Release, String> {
    let url = format!("{}/{FEED}", config::DOWNLOADS_URL);
    let mut response = agent().get(&url).call().map_err(|error| error.to_string())?;
    response.body_mut().read_json().map_err(|error| error.to_string())
}

/// Downloads the new exe beside the running one, checks it, and swaps it in;
/// `relaunch_updated` then starts it.
fn download_and_stage(release: &Release) -> Result<(), String> {
    let failed = |_| "Couldn't download the update. Try again later.".to_string();
    if !release.url.starts_with("https://") {
        return Err("The update isn't served securely, so it wasn't installed.".into());
    }
    let mut response = agent().get(&release.url).call().map_err(failed)?;
    let bytes = response
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(failed)?;
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if !digest.eq_ignore_ascii_case(release.sha256.trim()) {
        return Err("The update didn't match its checksum, so it wasn't installed.".into());
    }
    crate::platform::stage_update(&bytes)
}

/// Dotted numeric versions: "1.2.10" is newer than "1.2.9".
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |version: &str| -> Vec<u64> {
        version
            .trim()
            .trim_start_matches('v')
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (candidate, current) = (parse(candidate), parse(current));
    for index in 0..candidate.len().max(current.len()) {
        let (a, b) = (
            candidate.get(index).copied().unwrap_or(0),
            current.get(index).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("1.2.10", "1.2.9"));
        assert!(is_newer("2.0", "1.9.9"));
        assert!(!is_newer("1.0.0", "1.0"));
        assert!(!is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("v1.1.0", "1.0.0"));
    }

    #[test]
    fn decodes_the_feed() {
        let release: Release = serde_json::from_str(
            r#"{"version":"1.0.1","url":"https://download.shouldertap.app/windows/Shouldertap-Setup-1.0.1.exe","sha256":"ab"}"#,
        )
        .unwrap();
        assert_eq!(release.version, "1.0.1");
    }
}
