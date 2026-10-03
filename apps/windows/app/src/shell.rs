//! The app around the store, like AppDelegate in apps/macos's App.swift: a
//! tray icon with a menu, full-screen overlays when a tap arrives, and the
//! system events (wake, network, displays) that should reconnect or redraw.

use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    AnyWindowHandle, App, AppContext, BorrowAppContext, Bounds, Entity, Global, Task, WindowBackgroundAppearance,
    WindowBounds, WindowHandle, WindowKind, WindowOptions, point, px, size,
};
use shouldertap_core::fingerprint::{DEBUG_SALT, RELEASE_SALT, machine_fingerprint};
use shouldertap_core::{
    ActiveTap, DevicePlatform, LocalPersistence, NetworkTransport, ReceiverStore, StoreConfig, StoreState, TapResponse,
};

use crate::mark::{self, KNOCK_DURATION};
use crate::menu::MenuView;
use crate::overlay::{Overlays, Respond};
use crate::platform::{self, PlatformEvent};
use crate::updates::Updates;
use crate::{config, updates};

/// What every view reads: the store and its latest state.
pub struct Model {
    pub store: ReceiverStore,
    pub state: StoreState,
    pub updates: updates::Status,
    pub launch_at_login: bool,
}

pub struct Shell {
    pub model: Entity<Model>,
    overlays: Overlays,
    respond: Respond,
    menu: Option<WindowHandle<MenuView>>,
    /// GPUI quits on Windows when its last window closes; this one is never
    /// shown, so the tray app lives on with no menu or overlay open.
    _anchor: AnyWindowHandle,
    tray: Option<platform::Tray>,
    knocking: Option<Task<()>>,
    pub(crate) updates: Updates,
    /// When the menu last closed because something else was clicked: a click
    /// on the tray icon does that first, and mustn't then reopen it.
    menu_deactivated_at: Option<Instant>,
}

impl Global for Shell {}

impl Shell {
    pub fn launch(cx: &mut App) {
        let (events_tx, events) = mpsc::unbounded();
        let tray = platform::Tray::create(events_tx.clone()).ok();

        let store = ReceiverStore::new(StoreConfig {
            endpoints: config::endpoints(),
            persistence: Box::new(LocalPersistence::new(config::data_dir(), platform::vault())),
            device_name: Box::new(platform::device_name),
            platform: DevicePlatform::Windows,
            machine: Box::new(|| {
                let salt = if config::DEV { DEBUG_SALT } else { RELEASE_SALT };
                platform::hardware_id().and_then(|id| machine_fingerprint(&id, salt))
            }),
            transport: Arc::new(NetworkTransport::default()),
            ack_retry_delay: Duration::from_secs(10),
        });

        // Store changes arrive on its threads; redraw on this one.
        let (changes_tx, mut changes) = mpsc::unbounded::<()>();
        store.on_change(move || {
            let _ = changes_tx.unbounded_send(());
        });

        let model = cx.new(|_| Model {
            store: store.clone(),
            state: store.state(),
            updates: updates::Status::default(),
            launch_at_login: platform::launch_at_login(),
        });
        let respond: Respond = Rc::new(|tap_id: &str, response: TapResponse, cx: &mut App| {
            let store = cx.global::<Shell>().model.read(cx).store.clone();
            store.respond(tap_id, response);
        });

        let anchor = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(1.), px(1.)),
                    ))),
                    titlebar: None,
                    focus: false,
                    show: false,
                    kind: WindowKind::PopUp,
                    is_movable: false,
                    is_resizable: false,
                    is_minimizable: false,
                    window_background: WindowBackgroundAppearance::Transparent,
                    ..Default::default()
                },
                |_, cx| cx.new(|_| gpui::Empty),
            )
            .expect("open the anchor window")
            .into();

        let updates = Updates::start(cx);
        cx.set_global(Shell {
            model: model.clone(),
            overlays: Overlays::default(),
            respond,
            menu: None,
            _anchor: anchor,
            tray,
            knocking: None,
            updates,
            menu_deactivated_at: None,
        });

        cx.spawn(async move |cx| {
            while changes.next().await.is_some() {
                // Coalesce a burst of changes into one redraw.
                while let Ok(()) = changes.try_recv() {}
                if cx.update(Shell::store_changed).is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut events = events;
        cx.spawn(async move |cx| {
            while let Some(event) = events.next().await {
                if cx.update(|cx| Shell::handle(event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        platform::watch_system(events_tx);
        cx.on_app_quit(|_| async { platform::on_quit() }).detach();

        // Not set up yet: open the menu so there's somewhere to start.
        // Without a tray (developing on a Mac), it's the only way in.
        if !store.start() || cfg!(not(windows)) {
            Shell::open_menu(cx);
        }
        Shell::store_changed(cx);
    }

    /// Re-run whenever the store changes: redraw, and show or hide overlays.
    fn store_changed(cx: &mut App) {
        let model = cx.global::<Shell>().model.clone();
        let state = model.read(cx).store.state();
        let active = state.active_tap();
        model.update(cx, |model, cx| {
            model.state = state;
            cx.notify();
        });
        cx.update_global::<Shell, _>(|shell, cx| {
            let respond = shell.respond.clone();
            shell.overlays.update(active.clone(), &respond, cx);
            shell.set_knocking(active.is_some(), cx);
            if let Some(tray) = &shell.tray {
                tray.set_tooltip(&tooltip(active.as_ref()));
            }
        });
        if let Some(active) = active {
            model.read(cx).store.did_display(&active.tap.id);
        }
    }

    fn handle(event: PlatformEvent, cx: &mut App) {
        match event {
            PlatformEvent::TrayClicked => Shell::toggle_menu(cx),
            PlatformEvent::OpenMenu => Shell::open_menu(cx),
            PlatformEvent::Quit => cx.quit(),
            PlatformEvent::NetworkChanged => cx.global::<Shell>().model.read(cx).store.nudge(),
            PlatformEvent::Resumed => {
                cx.global::<Shell>().model.read(cx).store.nudge();
                Shell::displays_changed(cx);
            }
            PlatformEvent::DisplaysChanged => Shell::displays_changed(cx),
            PlatformEvent::ThemeChanged => cx.update_global::<Shell, _>(|shell, _| {
                if let Some(tray) = &shell.tray {
                    tray.refresh_icon();
                }
            }),
        }
    }

    fn displays_changed(cx: &mut App) {
        cx.update_global::<Shell, _>(|shell, cx| {
            let respond = shell.respond.clone();
            shell.overlays.displays_changed(&respond, cx);
        });
    }

    // Menu

    pub fn toggle_menu(cx: &mut App) {
        let shell = cx.global::<Shell>();
        let just_closed = shell
            .menu_deactivated_at
            .is_some_and(|at| at.elapsed() < Duration::from_millis(400));
        let open = shell.menu.is_some_and(|menu| menu.update(cx, |_, _, _| ()).is_ok());
        if open {
            Shell::close_menu(cx)
        } else if !just_closed {
            Shell::open_menu(cx)
        }
    }

    /// Like a flyout, the menu closes when you click anywhere else.
    pub fn menu_deactivated(cx: &mut App) {
        cx.global_mut::<Shell>().menu_deactivated_at = Some(Instant::now());
        // After this frame: the window is mid-event.
        cx.defer(Shell::close_menu);
    }

    pub fn open_menu(cx: &mut App) {
        let existing = cx.global::<Shell>().menu;
        if let Some(menu) = existing
            && menu.update(cx, |_, window, _| window.activate_window()).is_ok()
        {
            return;
        }
        let model = cx.global::<Shell>().model.clone();
        // One GET: picks up a purchase made while the live event was missed.
        model.read(cx).store.refresh();
        let anchor = cx.global::<Shell>().tray.as_ref().and_then(|tray| tray.anchor());
        let menu = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(platform::menu_bounds(anchor, cx))),
                titlebar: None,
                focus: true,
                show: true,
                kind: WindowKind::PopUp,
                is_movable: false,
                is_resizable: false,
                is_minimizable: false,
                window_background: WindowBackgroundAppearance::Opaque,
                app_id: Some(config::APP_ID.into()),
                ..Default::default()
            },
            move |window, cx| {
                platform::prepare_menu(window, anchor);
                cx.new(|cx| MenuView::new(model, anchor, window, cx))
            },
        );
        let menu = menu.ok();
        if let Some(menu) = menu {
            let _ = menu.update(cx, |_, window, _| {
                window.activate_window();
                platform::focus_menu(window);
            });
        }
        cx.global_mut::<Shell>().menu = menu;
    }

    pub fn close_menu(cx: &mut App) {
        // Freed when it closes, so the app idles at its smallest.
        if let Some(menu) = cx.global_mut::<Shell>().menu.take() {
            let _ = menu.update(cx, |_, window, _| window.remove_window());
        }
    }

    pub fn check_for_updates(cx: &mut App) {
        updates::check_now(cx);
    }

    pub fn install_update(cx: &mut App) {
        updates::install(cx);
    }

    // Tray

    /// While a tap waits, the knock marks knock twice and again every few
    /// seconds until it's answered, never with reduced motion. Frames run
    /// only during a knock; between knocks one timer sleeps.
    fn set_knocking(&mut self, pending: bool, cx: &mut App) {
        if pending == self.knocking.is_some() {
            return;
        }
        let Some(tray) = self.tray.clone() else { return };
        if !pending || platform::reduce_motion() {
            self.knocking = None;
            tray.set_knocks(mark::RESTING);
            return;
        }
        self.knocking = Some(cx.spawn(async move |cx| {
            loop {
                let start = std::time::Instant::now();
                loop {
                    let elapsed = start.elapsed().as_secs_f32();
                    if elapsed >= KNOCK_DURATION {
                        break;
                    }
                    tray.set_knocks(mark::knock_states(elapsed));
                    cx.background_executor().timer(Duration::from_millis(16)).await;
                }
                tray.set_knocks(mark::RESTING);
                cx.background_executor().timer(Duration::from_secs(4)).await;
            }
        }));
    }
}

fn tooltip(active: Option<&ActiveTap>) -> String {
    match active {
        None => config::APP_NAME.into(),
        Some(active) if active.queued == 0 => {
            format!("{} · {} is tapping you", config::APP_NAME, active.tap.sender_name)
        }
        Some(active) => format!("{} · {} taps waiting", config::APP_NAME, active.queued + 1),
    }
}
