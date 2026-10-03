//! Everything that differs by OS. Windows is the product; the fallback lets
//! the app run on a Mac (or Linux) for development: no tray, the menu opens as
//! a window, and the overlay stays a normal top-level window.

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

#[cfg(not(windows))]
mod fallback;
#[cfg(not(windows))]
pub use fallback::*;

/// Things the system tells the app, delivered on its main thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))] // Only Windows sends them.
pub enum PlatformEvent {
    /// The tray icon was clicked (or chosen with the keyboard).
    TrayClicked,
    /// "Open Shouldertap" from the tray's context menu, or launched again.
    OpenMenu,
    Quit,
    /// Woke from sleep or the session was unlocked: the socket may be dead.
    Resumed,
    NetworkChanged,
    DisplaysChanged,
    /// Light/dark changed: the tray icon follows the taskbar.
    ThemeChanged,
}

/// Where the tray icon is, in physical screen pixels, so the menu can open
/// beside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrayAnchor {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// The menu's width, in logical pixels.
pub const MENU_WIDTH: f32 = 380.;
