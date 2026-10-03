//! One exe that installs, updates and uninstalls itself, per user, with no
//! admin prompt: run from Downloads, it copies itself to
//! `%LocalAppData%\Programs\Shouldertap`, adds itself to the Start menu,
//! Settings › Apps and login, and starts from there. A stable path keeps the
//! tray icon's identity (and its "always show" setting) across updates.
//!
//!   Shouldertap.exe --install [--silent]   install (winget passes --silent)
//!   Shouldertap.exe --uninstall [--silent] uninstall (Settings › Apps)

use std::path::{Path, PathBuf};
use std::process::Command;

use windows::Win32::Foundation::HWND;
use windows::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
    WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE, WinVerifyTrust,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, IPersistFile,
};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteTreeW};
use windows::Win32::UI::Shell::{FOLDERID_Programs, IShellLinkW, KF_FLAG_DEFAULT, SHGetKnownFolderPath, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{MB_ICONINFORMATION, MB_OK, MessageBoxW};
use windows::core::{HSTRING, Interface, PCWSTR};

use super::{WM_APP_QUIT, post_to_running, set_launch_at_login, write_dword, write_string};
use crate::config;

const EXE: &str = "Shouldertap.exe";
const UNINSTALL_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Shouldertap";

fn install_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("Programs").join("Shouldertap"))
}

fn has(argument: &str) -> bool {
    std::env::args().any(|arg| arg == argument)
}

/// Handles `--install` / `--uninstall`, and installs when run from anywhere
/// but the install folder. Returns true when this process should exit.
/// Dev builds (`cargo run`) run in place.
pub fn handle_install_arguments() -> bool {
    if has("--uninstall") {
        uninstall();
        return true;
    }
    if config::DEV && !has("--install") {
        return false;
    }
    let (Ok(current), Some(dir)) = (std::env::current_exe(), install_dir()) else {
        return false;
    };
    let installed = dir.join(EXE);
    let running_installed = same_file(&current, &installed);
    if running_installed && !has("--install") {
        return false;
    }
    match install(&current, &dir, running_installed) {
        Ok(()) => {
            if !has("--silent") {
                let _ = Command::new(&installed).spawn();
            }
        }
        Err(error) => message(&format!("Shouldertap couldn't be installed: {error}")),
    }
    true
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn install(current: &Path, dir: &Path, in_place: bool) -> Result<(), String> {
    let installed = dir.join(EXE);
    if !in_place {
        // A running copy holds its exe open: ask it to quit, then swap.
        if post_to_running(WM_APP_QUIT) {
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let old = dir.join("Shouldertap.old.exe");
        let _ = std::fs::remove_file(&old);
        if installed.exists() {
            std::fs::rename(&installed, &old).map_err(|error| error.to_string())?;
        }
        std::fs::copy(current, &installed).map_err(|error| error.to_string())?;
    }
    register(&installed, dir)?;
    let _ = shortcut(&installed);
    // Opens at login from the start, like the Mac app's default.
    set_launch_at_login_for(&installed)?;
    Ok(())
}

/// Settings › Apps lists it, with an Uninstall button.
fn register(exe: &Path, dir: &Path) -> Result<(), String> {
    let key = HSTRING::from(UNINSTALL_KEY);
    let key = PCWSTR(key.as_ptr());
    let exe = exe.display().to_string();
    let size_kb = std::fs::metadata(&exe)
        .map(|meta| (meta.len() / 1024) as u32)
        .unwrap_or(0);
    let strings = [
        ("DisplayName", "Shouldertap".to_string()),
        ("DisplayVersion", config::VERSION.to_string()),
        ("Publisher", "Shouldertap".to_string()),
        ("DisplayIcon", format!("{exe},0")),
        ("InstallLocation", dir.display().to_string()),
        ("UninstallString", format!("\"{exe}\" --uninstall")),
        ("QuietUninstallString", format!("\"{exe}\" --uninstall --silent")),
        ("URLInfoAbout", "https://shouldertap.app".to_string()),
        ("HelpLink", "https://shouldertap.app/support".to_string()),
    ];
    for (name, value) in strings {
        write_string(HKEY_CURRENT_USER, key, &HSTRING::from(name), &value)?;
    }
    for (name, value) in [("NoModify", 1), ("NoRepair", 1), ("EstimatedSize", size_kb)] {
        write_dword(HKEY_CURRENT_USER, key, &HSTRING::from(name), value)?;
    }
    Ok(())
}

fn start_menu_link() -> Option<PathBuf> {
    unsafe {
        let folder = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None).ok()?;
        let path = PathBuf::from(folder.to_string().ok()?);
        windows::Win32::System::Com::CoTaskMemFree(Some(folder.0 as *const _));
        Some(path.join("Shouldertap.lnk"))
    }
}

/// A Start menu entry, so launching it again (which shows the menu) is easy.
fn shortcut(exe: &Path) -> Result<(), String> {
    let link_path = start_menu_link().ok_or("no Start menu folder")?;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|error| error.to_string())?;
        link.SetPath(&HSTRING::from(exe.as_os_str()))
            .map_err(|error| error.to_string())?;
        link.SetDescription(&HSTRING::from("Taps from people you trust, on every screen"))
            .map_err(|error| error.to_string())?;
        let file: IPersistFile = link.cast().map_err(|error| error.to_string())?;
        file.Save(&HSTRING::from(link_path.as_os_str()), true)
            .map_err(|error| error.to_string())
    }
}

fn set_launch_at_login_for(exe: &Path) -> Result<(), String> {
    // `set_launch_at_login` records the running exe; record the installed one.
    let name = HSTRING::from(config::APP_NAME);
    write_string(
        HKEY_CURRENT_USER,
        windows::core::w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
        &name,
        &format!("\"{}\" --background", exe.display()),
    )
}

/// Removes the app, its Start menu entry, login item and Apps entry. Like
/// dragging the Mac app to the Trash, the pairing stays, so reinstalling
/// picks up where it left off.
fn uninstall() {
    if post_to_running(WM_APP_QUIT) {
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    let _ = set_launch_at_login(false);
    if let Some(link) = start_menu_link() {
        let _ = std::fs::remove_file(link);
    }
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(UNINSTALL_KEY));
    }
    if let Some(dir) = install_dir() {
        // This exe can't delete itself while running: a short-lived shell
        // removes the folder once it has exited.
        let script = format!("ping -n 3 127.0.0.1 > nul & rmdir /s /q \"{}\"", dir.display());
        let _ = Command::new("cmd")
            .args(["/c", &script])
            .creation_flags_hidden()
            .spawn();
    }
    if !has("--silent") {
        message("Shouldertap was uninstalled.");
    }
}

fn message(text: &str) {
    unsafe {
        MessageBoxW(
            None::<HWND>,
            &HSTRING::from(text),
            &HSTRING::from("Shouldertap"),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

trait Hidden {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}

impl Hidden for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

// Updates (crate::updates downloads and checks the checksum)

/// Swaps the downloaded exe in beside the running one: Windows lets a
/// running exe be renamed, not replaced.
pub fn stage_update(bytes: &[u8]) -> Result<(), String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let dir = current.parent().ok_or("no install folder")?;
    let staged = dir.join("Shouldertap.new.exe");
    let old = dir.join("Shouldertap.old.exe");
    std::fs::write(&staged, bytes).map_err(|_| "Couldn't save the update.".to_string())?;
    // Once this build is signed, updates must be too.
    if verify_signature(&current) && !verify_signature(&staged) {
        let _ = std::fs::remove_file(&staged);
        return Err("The update isn't signed by Shouldertap, so it wasn't installed.".into());
    }
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&current, &old).map_err(|_| "Couldn't install the update.".to_string())?;
    if let Err(error) = std::fs::rename(&staged, &current) {
        let _ = std::fs::rename(&old, &current);
        return Err(format!("Couldn't install the update ({error})."));
    }
    Ok(())
}

/// Starts the new exe; it waits for this one to quit before taking over.
pub fn relaunch_updated() {
    if let Ok(current) = std::env::current_exe() {
        let _ = Command::new(current).arg("--updated").spawn();
    }
}

/// The previous exe, left behind by an update.
pub fn clean_up_after_update() {
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        let _ = std::fs::remove_file(dir.join("Shouldertap.old.exe"));
        // A new version records its own version in Settings › Apps.
        let key = HSTRING::from(UNINSTALL_KEY);
        if install_dir().is_some_and(|install| same_file(&install, &dir)) {
            let _ = write_string(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                &HSTRING::from("DisplayVersion"),
                config::VERSION,
            );
        }
    }
}

/// Authenticode: true when `path` carries a valid, trusted signature.
fn verify_signature(path: &Path) -> bool {
    let path = HSTRING::from(path.as_os_str());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(path.as_ptr()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    unsafe {
        let result = WinVerifyTrust(HWND(-1isize as *mut _), &mut action, &mut data as *mut _ as *mut _);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(HWND(-1isize as *mut _), &mut action, &mut data as *mut _ as *mut _);
        result == 0
    }
}
