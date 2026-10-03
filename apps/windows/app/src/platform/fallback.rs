//! Development stand-ins for the Windows platform layer.

use futures::channel::mpsc::UnboundedSender;
use gpui::{App, Bounds, Pixels, Window, WindowAppearance, point, px, size};
use shouldertap_core::CredentialVault;

use super::{MENU_WIDTH, PlatformEvent, TrayAnchor};
use crate::mark::Knock;
use crate::menu::MIN_HEIGHT;

#[derive(Clone)]
pub struct Tray;

impl Tray {
    pub fn create(_: UnboundedSender<PlatformEvent>) -> Result<Self, String> {
        Err("no tray outside Windows".into())
    }
    pub fn set_knocks(&self, _: [Knock; 3]) {}
    pub fn set_tooltip(&self, _: &str) {}
    pub fn refresh_icon(&self) {}
    pub fn anchor(&self) -> Option<TrayAnchor> {
        None
    }
}

/// Runs once; false when another copy is already running (and was asked to
/// show its menu).
pub fn claim_single_instance() -> bool {
    true
}

pub fn watch_system(_: UnboundedSender<PlatformEvent>) {}

pub fn on_quit() {}

pub fn vault() -> Option<Box<dyn CredentialVault>> {
    None
}

pub fn device_name() -> String {
    "Dev PC".into()
}

pub fn hardware_id() -> Option<String> {
    None
}

pub fn reduce_motion() -> bool {
    std::env::var_os("SHOULDERTAP_REDUCE_MOTION").is_some()
}

pub fn is_dark(window: &Window) -> bool {
    matches!(
        window.appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

pub fn launch_at_login() -> bool {
    false
}

pub fn set_launch_at_login(_: bool) -> Result<(), String> {
    Err("Only on Windows".into())
}

pub fn window_has_pointer(_: &Window) -> bool {
    false
}

pub fn present_overlay(window: &mut Window, focus: bool, _: &mut App) {
    if focus {
        window.activate_window();
    }
}

pub fn menu_bounds(_: Option<TrayAnchor>, cx: &App) -> Bounds<Pixels> {
    let display = cx.primary_display().map(|display| display.bounds());
    let right = display.map(|bounds| bounds.right()).unwrap_or(px(1440.));
    let top = display.map(|bounds| bounds.top()).unwrap_or(px(0.));
    Bounds::new(
        point(right - px(MENU_WIDTH + 16.), top + px(40.)),
        size(px(MENU_WIDTH), px(MIN_HEIGHT)),
    )
}

pub fn prepare_menu(_: &mut Window, _: Option<TrayAnchor>, _: &mut App) {}

pub fn focus_menu(_: &mut Window) {}

pub fn resize_menu(window: &mut Window, height: f32, _: Option<TrayAnchor>, _: &mut App) {
    window.resize(size(px(MENU_WIDTH), px(height)));
}

pub fn clean_up_after_update() {}

pub fn stage_update(_: &[u8]) -> Result<(), String> {
    Err("Updates install only on Windows.".into())
}

pub fn relaunch_updated() {}

/// Self-install and uninstall are Windows-only; nothing to do here.
pub fn handle_install_arguments() -> bool {
    false
}
