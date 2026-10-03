//! Shouldertap for Windows: a tray app that covers every display with a tap
//! until it's answered. The Windows twin of apps/macos; the protocol and
//! store live in `shouldertap-core`.

// No console window in release builds.
#![cfg_attr(not(dev_build), windows_subsystem = "windows")]

mod assets;
mod config;
mod mark;
mod menu;
mod overlay;
mod platform;
mod qr;
mod shell;
mod text_field;
mod theme;
mod updates;

use std::borrow::Cow;

use gpui::Application;

fn main() {
    // `--install`, `--uninstall` and the first run from Downloads finish here.
    if platform::handle_install_arguments() {
        return;
    }
    // Launching again shows the running copy's menu instead.
    if !platform::claim_single_instance() {
        return;
    }
    let app = Application::new().with_assets(assets::Assets);
    // Opening the app again (where the OS says so) shows the menu.
    app.on_reopen(shell::Shell::open_menu);
    app.run(|cx| {
        let fonts = assets::FONTS.iter().map(|font| Cow::Borrowed(*font)).collect();
        cx.text_system().add_fonts(fonts).expect("load the bundled fonts");
        text_field::bind_keys(cx);
        shell::Shell::launch(cx);
    });
}
