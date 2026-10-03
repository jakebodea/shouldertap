//! The Windows platform layer: windows above everything, focus, the system's
//! settings, the pairing in Credential Manager, open at login, and one copy
//! running at a time. The tray is in `tray`, install and update in `install`.

mod install;
mod tray;

use std::ffi::c_void;
use std::sync::OnceLock;

use futures::channel::mpsc::UnboundedSender;
use gpui::{App, Bounds, Pixels, Window, WindowAppearance, point, px, size};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use shouldertap_core::CredentialVault;
use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HWND, LPARAM, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint,
    MonitorFromWindow,
};
use windows::Win32::NetworkManagement::IpHelper::NotifyAddrChange;
use windows::Win32::Security::Credentials::{
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
};
use windows::Win32::System::SystemInformation::{
    COMPUTER_NAME_FORMAT, ComputerNamePhysicalDnsHostname, GetComputerNameExW,
};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CalculatePopupWindowPosition, FindWindowW, GWL_STYLE, GetCursorPos, GetForegroundWindow, GetWindowRect,
    HWND_TOPMOST, PostMessageW, SPI_GETCLIENTAREAANIMATION, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOSIZE,
    SWP_SHOWWINDOW, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetForegroundWindow, SetPropW, SetWindowLongPtrW,
    SetWindowPos, SystemParametersInfoW, TPM_BOTTOMALIGN, TPM_CENTERALIGN, TPM_RIGHTALIGN, TPM_VERTICAL, TPM_WORKAREA,
    WS_POPUP, WS_VISIBLE,
};
use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR, w};

pub use install::{clean_up_after_update, handle_install_arguments, relaunch_updated, stage_update};
pub use tray::Tray;

use super::{MENU_WIDTH, PlatformEvent, TrayAnchor};
use crate::config;
use crate::menu::MIN_HEIGHT;

/// The hidden window's class: one per build flavor, so a dev build and the
/// installed app run side by side and each finds its own running copy.
pub(crate) fn window_class() -> PCWSTR {
    if config::DEV {
        w!("ShouldertapDebugTray")
    } else {
        w!("ShouldertapTray")
    }
}

/// Posted to a running copy: show the menu (launched again) or quit (uninstall, update).
pub(crate) const WM_APP_SHOW: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 2;
pub(crate) const WM_APP_QUIT: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 3;

// Single instance

/// Runs once; false when another copy is already running, which is asked to
/// show its menu instead. A copy started by an update waits for the old one
/// to quit first.
pub fn claim_single_instance() -> bool {
    static MUTEX: OnceLock<usize> = OnceLock::new();
    let name = HSTRING::from(format!("Local\\{}-running", config::APP_ID));
    let updating = std::env::args().any(|arg| arg == "--updated");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let Ok(handle) = (unsafe { CreateMutexW(None, true, &name) }) else {
            return true;
        };
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            let _ = MUTEX.set(handle.0 as usize);
            return true;
        }
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }
        if !updating || std::time::Instant::now() > deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    post_to_running(WM_APP_SHOW);
    false
}

/// Sends a message to the running copy's hidden window, if there is one.
pub(crate) fn post_to_running(message: u32) -> bool {
    unsafe {
        match FindWindowW(window_class(), PCWSTR::null()) {
            Ok(hwnd) if !hwnd.is_invalid() => PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0)).is_ok(),
            _ => false,
        }
    }
}

// System events

static EVENTS: OnceLock<UnboundedSender<PlatformEvent>> = OnceLock::new();

pub(crate) fn send(event: PlatformEvent) {
    if let Some(events) = EVENTS.get() {
        let _ = events.unbounded_send(event);
    }
}

/// Network changes come from IP Helper on a thread of their own; wake,
/// unlock, display and theme changes reach the tray's hidden window.
pub(crate) fn set_events(events: UnboundedSender<PlatformEvent>) {
    let _ = EVENTS.set(events);
}

/// Takes the tray icon away as the app quits.
pub fn on_quit() {
    tray::remove_icon();
}

pub fn watch_system(events: UnboundedSender<PlatformEvent>) {
    set_events(events);
    std::thread::Builder::new()
        .name("shouldertap-network".into())
        .spawn(|| {
            loop {
                // Blocks until an address changes.
                if unsafe { NotifyAddrChange(std::ptr::null_mut(), std::ptr::null()) } != 0 {
                    return;
                }
                // Addresses settle in a burst; reconnect once they have.
                std::thread::sleep(std::time::Duration::from_secs(2));
                send(PlatformEvent::NetworkChanged);
            }
        })
        .ok();
}

// Settings

pub fn reduce_motion() -> bool {
    let mut animate = BOOL(1);
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut animate as *mut BOOL as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    !animate.as_bool()
}

pub fn is_dark(window: &Window) -> bool {
    matches!(
        window.appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

/// The taskbar's own theme (it can differ from apps'): the tray icon is
/// white on a dark taskbar and black on a light one.
pub(crate) fn taskbar_is_light() -> bool {
    read_dword(
        HKEY_CURRENT_USER,
        w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
        w!("SystemUsesLightTheme"),
    ) == Some(1)
}

/// The name the inbox lists for this PC: its computer name, unless Windows
/// made one up ("DESKTOP-7Q2B9XK").
pub fn device_name() -> String {
    let name = computer_name(ComputerNamePhysicalDnsHostname).unwrap_or_default();
    let generated = ["DESKTOP-", "LAPTOP-"]
        .iter()
        .any(|prefix| name.to_ascii_uppercase().starts_with(prefix) && name.len() == prefix.len() + 7);
    if name.is_empty() || generated {
        "Windows PC".into()
    } else {
        name
    }
}

fn computer_name(format: COMPUTER_NAME_FORMAT) -> Option<String> {
    let mut length = 0u32;
    unsafe {
        let _ = GetComputerNameExW(format, None, &mut length);
        let mut buffer = vec![0u16; length as usize + 1];
        GetComputerNameExW(format, Some(PWSTR(buffer.as_mut_ptr())), &mut length).ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

/// This PC's MachineGuid, for its one free trial. It never leaves the PC;
/// only its salted hash does.
pub fn hardware_id() -> Option<String> {
    read_string(
        HKEY_LOCAL_MACHINE,
        w!("SOFTWARE\\Microsoft\\Cryptography"),
        w!("MachineGuid"),
    )
}

// Open at login

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const STARTUP_APPROVED: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run");

fn run_value() -> HSTRING {
    HSTRING::from(config::APP_NAME)
}

/// On when the Run key starts this exe, unless it's turned off in Settings
/// › Apps › Startup (which Windows records separately).
pub fn launch_at_login() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let command = read_string(HKEY_CURRENT_USER, RUN_KEY, PCWSTR(run_value().as_ptr()));
    let starts_this = command.is_some_and(|command| command.contains(&*exe.to_string_lossy()));
    let disabled = read_binary(HKEY_CURRENT_USER, STARTUP_APPROVED, PCWSTR(run_value().as_ptr()))
        .and_then(|value| value.first().copied())
        .is_some_and(|flag| flag & 1 == 1);
    starts_this && !disabled
}

pub fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = run_value();
    unsafe {
        // Settings' Startup switch overrides the Run key; clear it either way.
        let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, STARTUP_APPROVED, PCWSTR(name.as_ptr()));
        if enabled {
            let command = format!("\"{}\" --background", exe.display());
            write_string(HKEY_CURRENT_USER, RUN_KEY, &name, &command)
        } else {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, PCWSTR(name.as_ptr()));
            Ok(())
        }
    }
}

// Windows

pub(crate) fn hwnd(window: &Window) -> Option<HWND> {
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(HWND(handle.hwnd.get() as *mut c_void)),
        _ => None,
    }
}

pub fn window_has_pointer(window: &Window) -> bool {
    let Some(hwnd) = hwnd(window) else { return false };
    let mut cursor = POINT::default();
    unsafe {
        GetCursorPos(&mut cursor).is_ok()
            && MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST) == MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    }
}

/// Covers the window's whole display, taskbar included, above every other
/// window (full-screen ones too), and takes the keyboard when `focus`.
pub fn present_overlay(window: &mut Window, focus: bool) {
    let Some(hwnd) = hwnd(window) else { return };
    unsafe {
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return;
        }
        let area = info.rcMonitor;
        SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_POPUP | WS_VISIBLE).0 as isize);
        // Keeps the taskbar from treating it as a full-screen app it should
        // step aside for.
        let _ = SetPropW(hwnd, w!("NonRudeHWND"), Some(HANDLE(1 as *mut c_void)));
        let mut flags = SWP_FRAMECHANGED | SWP_SHOWWINDOW;
        if !focus {
            flags |= SWP_NOACTIVATE;
        }
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            area.left,
            area.top,
            area.right - area.left,
            area.bottom - area.top,
            flags,
        );
        if focus {
            force_foreground(hwnd);
        }
    }
}

/// Windows lets an app take the foreground only right after input it got.
/// A tap isn't input, so this presses Alt, which re-allows
/// `SetForegroundWindow` (LockSetForegroundWindow's documented exception);
/// the Alt release lands on the overlay, which ignores it. Clicks reach a
/// topmost window regardless, so answering works even if this fails.
pub(crate) fn force_foreground(hwnd: HWND) {
    unsafe {
        if GetForegroundWindow() == hwnd || SetForegroundWindow(hwnd).as_bool() {
            return;
        }
        let alt = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_MENU,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        SendInput(&[alt(KEYBD_EVENT_FLAGS(0))], size_of::<INPUT>() as i32);
        let _ = SetForegroundWindow(hwnd);
        SendInput(&[alt(KEYEVENTF_KEYUP)], size_of::<INPUT>() as i32);
    }
}

// The menu

/// Where the menu window first opens; `place_menu` then puts it by the tray.
pub fn menu_bounds(_: Option<TrayAnchor>, cx: &App) -> Bounds<Pixels> {
    let display = cx.primary_display().map(|display| display.bounds());
    let right = display.map(|bounds| bounds.right()).unwrap_or(px(1280.));
    let bottom = display.map(|bounds| bounds.bottom()).unwrap_or(px(720.));
    Bounds::new(
        point(right - px(MENU_WIDTH + 12.), bottom - px(MIN_HEIGHT + 60.)),
        size(px(MENU_WIDTH), px(MIN_HEIGHT)),
    )
}

/// A flyout: rounded corners on Windows 11, above other windows, by the tray.
pub fn prepare_menu(window: &mut Window, anchor: Option<TrayAnchor>) {
    let Some(hwnd) = hwnd(window) else { return };
    unsafe {
        let round = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &round as *const _ as *const c_void,
            size_of_val(&round) as u32,
        );
    }
    place_menu(hwnd, anchor, None);
}

pub fn focus_menu(window: &mut Window) {
    if let Some(hwnd) = hwnd(window) {
        force_foreground(hwnd);
    }
}

/// Resizes and re-anchors in one move: a GPUI resize lands later, so placing
/// by the window's current size would put a growing menu off the screen.
pub fn resize_menu(window: &mut Window, height: f32, anchor: Option<TrayAnchor>) {
    match hwnd(window) {
        Some(hwnd) => place_menu(hwnd, anchor, Some(height)),
        None => window.resize(size(px(MENU_WIDTH), px(height))),
    }
}

/// Above the tray icon (or beside it, for a taskbar on another edge), kept
/// inside the work area; bottom right when the icon can't be found, as when
/// it's in the overflow.
/// `height` (logical pixels) resizes it too; None keeps its size.
fn place_menu(hwnd: HWND, anchor: Option<TrayAnchor>, height: Option<f32>) {
    unsafe {
        let dpi = windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd).max(96) as f32;
        let size = match height {
            Some(height) => SIZE {
                cx: (MENU_WIDTH * dpi / 96.).round() as i32,
                cy: (height * dpi / 96.).round() as i32,
            },
            None => {
                let mut window = RECT::default();
                if GetWindowRect(hwnd, &mut window).is_err() {
                    return;
                }
                SIZE {
                    cx: window.right - window.left,
                    cy: window.bottom - window.top,
                }
            }
        };
        // Windows 11 flyouts float 12px off the taskbar.
        let gap = (12. * dpi / 96.).round() as i32;
        let mut placed = RECT::default();
        let ok = match anchor {
            Some(icon) => {
                let exclude = RECT {
                    left: icon.left,
                    top: icon.top - gap,
                    right: icon.right,
                    bottom: icon.bottom + gap,
                };
                let at = POINT {
                    x: (icon.left + icon.right) / 2,
                    y: icon.top - gap,
                };
                CalculatePopupWindowPosition(
                    &at,
                    &size,
                    (TPM_CENTERALIGN | TPM_BOTTOMALIGN | TPM_VERTICAL | TPM_WORKAREA).0,
                    Some(&exclude),
                    &mut placed,
                )
                .is_ok()
            }
            None => {
                let mut info = MONITORINFO {
                    cbSize: size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                let monitor = MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY);
                let _ = GetMonitorInfoW(monitor, &mut info);
                let at = POINT {
                    x: info.rcWork.right - gap,
                    y: info.rcWork.bottom - gap,
                };
                CalculatePopupWindowPosition(
                    &at,
                    &size,
                    (TPM_RIGHTALIGN | TPM_BOTTOMALIGN | TPM_WORKAREA).0,
                    None,
                    &mut placed,
                )
                .is_ok()
            }
        };
        if ok {
            let flags = if height.is_some() {
                SWP_NOACTIVATE
            } else {
                SWP_NOSIZE | SWP_NOACTIVATE
            };
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                placed.left,
                placed.top,
                size.cx,
                size.cy,
                flags,
            );
        }
    }
}

// The pairing

/// The device credential, as a generic credential in Credential Manager
/// (protected by the user's Windows login, like the Mac's Keychain item).
struct CredentialManager {
    target: HSTRING,
}

pub fn vault() -> Option<Box<dyn CredentialVault>> {
    Some(Box::new(CredentialManager {
        target: HSTRING::from(format!("{}/credential", config::APP_ID)),
    }))
}

impl CredentialVault for CredentialManager {
    fn read(&self) -> Option<String> {
        unsafe {
            let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
            CredReadW(&self.target, CRED_TYPE_GENERIC, None, &mut credential).ok()?;
            let blob =
                std::slice::from_raw_parts((*credential).CredentialBlob, (*credential).CredentialBlobSize as usize);
            let token = String::from_utf8(blob.to_vec()).ok();
            CredFree(credential as *const c_void);
            token.filter(|token| !token.is_empty())
        }
    }

    fn write(&self, token: &str) -> Result<(), String> {
        let mut blob = token.as_bytes().to_vec();
        let user = HSTRING::from(config::APP_NAME);
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(self.target.as_ptr() as *mut u16),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_ptr() as *mut u16),
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }
            .map_err(|error| format!("Couldn't save the pairing to Credential Manager ({error})."))
    }

    fn delete(&self) {
        unsafe {
            let _ = CredDeleteW(&self.target, CRED_TYPE_GENERIC, None);
        }
    }
}

// Registry

fn read_string(key: HKEY, subkey: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut length = 0u32;
    unsafe {
        let flags = RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY;
        RegGetValueW(key, subkey, value, flags, None, None, Some(&mut length))
            .ok()
            .ok()?;
        let mut buffer = vec![0u16; length as usize / 2 + 1];
        RegGetValueW(
            key,
            subkey,
            value,
            flags,
            None,
            Some(buffer.as_mut_ptr() as *mut c_void),
            Some(&mut length),
        )
        .ok()
        .ok()?;
        let text = String::from_utf16_lossy(&buffer);
        Some(text.trim_end_matches('\0').to_string())
    }
}

fn read_dword(key: HKEY, subkey: PCWSTR, value: PCWSTR) -> Option<u32> {
    let mut data = 0u32;
    let mut length = size_of::<u32>() as u32;
    unsafe {
        RegGetValueW(
            key,
            subkey,
            value,
            windows::Win32::System::Registry::RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut c_void),
            Some(&mut length),
        )
        .ok()
        .ok()?;
    }
    Some(data)
}

fn read_binary(key: HKEY, subkey: PCWSTR, value: PCWSTR) -> Option<Vec<u8>> {
    let mut buffer = vec![0u8; 64];
    let mut length = buffer.len() as u32;
    unsafe {
        RegGetValueW(
            key,
            subkey,
            value,
            RRF_RT_REG_BINARY,
            None,
            Some(buffer.as_mut_ptr() as *mut c_void),
            Some(&mut length),
        )
        .ok()
        .ok()?;
    }
    buffer.truncate(length as usize);
    Some(buffer)
}

pub(crate) fn write_string(key: HKEY, subkey: PCWSTR, name: &HSTRING, value: &str) -> Result<(), String> {
    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        RegSetKeyValueW(
            key,
            subkey,
            PCWSTR(name.as_ptr()),
            REG_SZ.0,
            Some(wide.as_ptr() as *const c_void),
            (wide.len() * 2) as u32,
        )
        .ok()
        .map_err(|error| error.to_string())
    }
}

pub(crate) fn write_dword(key: HKEY, subkey: PCWSTR, name: &HSTRING, value: u32) -> Result<(), String> {
    unsafe {
        RegSetKeyValueW(
            key,
            subkey,
            PCWSTR(name.as_ptr()),
            windows::Win32::System::Registry::REG_DWORD.0,
            Some(&value as *const u32 as *const c_void),
            size_of::<u32>() as u32,
        )
        .ok()
        .map_err(|error| error.to_string())
    }
}
