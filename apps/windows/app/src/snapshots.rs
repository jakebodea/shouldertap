//! Development only: `SHOULDERTAP_RENDER_THEMES=<dir>` on a Mac opens each
//! theme in a real GPUI window, captures it mid-arrival and settled with
//! `screencapture`, then quits. Checks the renderers against the approved
//! mockup without a server.
//!
//! `SHOULDERTAP_RENDER_TAP=<body>` (with `SHOULDERTAP_RENDER_SENDER` and
//! `SHOULDERTAP_RENDER_COLOR`) renders just that one tap in the default theme
//! instead, for the App Store artwork (brand/app-store/capture-pc.sh).

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{App, AppContext, Bounds, Context, Entity, Render, Window, WindowBounds, WindowKind, WindowOptions, div};
use gpui::{point, prelude::*, px, size};
use shouldertap_core::{ActiveTap, PersonColor, Tap, TapState, TapTheme, now_ms};

use crate::text_field::TextField;
use crate::themes::{self, Scene};

const SHORT: &str = "Door! Package guy is here.";
const LONG: &str = "When you get a sec: the plumber needs the boxes moved out from under the kitchen sink before 3, and I'm stuck on this call until 2:45. Can you handle it? Thank you!!";
const STRESS: &str = "Pls sign before noon or the slot goes away: https://forms.example.com/school/permission-slip/fieldtrip-2026-10-24?student=ada-lovelace-hopper thx";

struct Case {
    name: String,
    theme: TapTheme,
    color: PersonColor,
    sender: String,
    body: String,
    queued: usize,
    /// How long ago the tap arrived, in ms.
    age: f64,
    width: f32,
    height: f32,
    replying: bool,
    frames: Vec<f32>,
}

/// The one tap `SHOULDERTAP_RENDER_TAP` asks for, full screen and settled.
fn single_tap() -> Option<Case> {
    let body = std::env::var("SHOULDERTAP_RENDER_TAP").ok()?;
    let color = std::env::var("SHOULDERTAP_RENDER_COLOR").ok();
    Some(Case {
        name: "tap".into(),
        theme: TapTheme::Default,
        color: PersonColor::ALL
            .into_iter()
            .find(|c| {
                color
                    .as_deref()
                    .is_some_and(|name| c.swatch().label.eq_ignore_ascii_case(name))
            })
            .unwrap_or(PersonColor::Moss),
        sender: std::env::var("SHOULDERTAP_RENDER_SENDER").unwrap_or_else(|_| "Maya".into()),
        body,
        queued: 0,
        age: 0.,
        width: 1440.,
        height: 900.,
        replying: false,
        frames: vec![4.],
    })
}

fn cases() -> Vec<Case> {
    let colors = |theme: TapTheme| match theme {
        TapTheme::Default => PersonColor::Moss,
        TapTheme::Broadsheet => PersonColor::Sky,
        TapTheme::Billboard => PersonColor::Tomato,
        TapTheme::Terminal => PersonColor::Plum,
        TapTheme::Note => PersonColor::Rose,
    };
    let mut all = Vec::new();
    for theme in TapTheme::ALL {
        let color = colors(theme);
        let case = |name: &str, body, width, height, replying, frames: Vec<f32>| Case {
            name: format!("{name}-{}", theme.label().to_lowercase()),
            theme,
            color,
            sender: "Maya".into(),
            body: String::from(body),
            queued: 1,
            age: 120_000.,
            width,
            height,
            replying,
            frames,
        };
        all.push(case("short", SHORT, 1440., 900., false, vec![4.]));
        all.push(case("long", LONG, 1440., 900., false, vec![4.]));
        all.push(case("stress", STRESS, 1440., 900., false, vec![4.]));
        all.push(case("reply", SHORT, 1440., 900., true, vec![4.]));
        all.push(case("portrait", LONG, 820., 1180., false, vec![4.]));
        if theme != TapTheme::Default {
            all.push(case("motion", SHORT, 1440., 900., false, vec![0.15, 0.4, 0.7]));
        }
    }
    all
}

struct Shot {
    scene_theme: TapTheme,
    active: ActiveTap,
    replying: bool,
    reply: Entity<TextField>,
    start: Instant,
}

impl Render for Shot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        window.request_animation_frame();
        let scene = Scene {
            theme: self.scene_theme,
            active: self.active.clone(),
            replying: self.replying,
            reply: self.reply.clone(),
            reply_empty: true,
            width: f32::from(viewport.width),
            height: f32::from(viewport.height),
            elapsed: self.start.elapsed().as_secs_f32(),
            reduce: false,
            actions: Rc::new(|_, _, _| {}),
            frame_scale: None,
        };
        div().size_full().child(themes::render(&scene, window, cx))
    }
}

pub fn run(directory: String, cx: &mut App) {
    let _ = std::fs::create_dir_all(&directory);
    let only = std::env::var("SHOULDERTAP_RENDER_ONLY").ok();
    let single = single_tap();
    let queue: Vec<Case> = match single {
        Some(case) => vec![case],
        None => cases()
            .into_iter()
            .filter(|c| only.as_ref().is_none_or(|o| c.name.contains(o)))
            .collect(),
    };
    let only_one = queue.len() == 1 && queue[0].name == "tap";
    cx.spawn(async move |cx| {
        for case in queue {
            let tap = Tap {
                id: case.name.clone(),
                sender_id: "s1".into(),
                sender_name: case.sender.clone(),
                sender_color: case.color,
                body: case.body.clone(),
                created_at: now_ms() - case.age,
                state: TapState::Pending,
                displayed_at: None,
                acknowledged_at: None,
                acknowledged_by: None,
                response: None,
                sequence: 0,
                theme: Some(case.theme),
                replies: None,
            };
            let (x, y) = (40., 60.);
            let _ = (x, y);
            let bounds = Bounds::new(point(px(x), px(y)), size(px(case.width), px(case.height)));
            let Ok(handle) = cx.update(|cx| {
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: None,
                        kind: WindowKind::PopUp,
                        focus: false,
                        ..Default::default()
                    },
                    |_, cx| {
                        let reply = cx.new(|cx| TextField::new(cx, format!("Reply to {}", case.sender), 280));
                        cx.new(|_| Shot {
                            scene_theme: case.theme,
                            active: ActiveTap {
                                tap,
                                queued: case.queued,
                            },
                            replying: case.replying,
                            reply,
                            start: Instant::now(),
                        })
                    },
                )
            }) else {
                continue;
            };
            let Ok(handle) = handle else { continue };
            let start = Instant::now();
            for at in &case.frames {
                let wait = Duration::from_secs_f32(*at).saturating_sub(start.elapsed());
                cx.background_executor().timer(wait).await;
                let suffix = if case.frames.len() > 1 {
                    format!("-{}ms", (at * 1000.) as u32)
                } else {
                    String::new()
                };
                let path = format!("{directory}/{}{suffix}.png", case.name);
                // Capture only this window, by id (a helper lists this
                // process's windows), never whatever else is on screen.
                let Ok(tool) = std::env::var("SHOULDERTAP_WINDOW_ID_TOOL") else {
                    continue;
                };
                let id = std::process::Command::new(tool)
                    .args([
                        std::process::id().to_string(),
                        case.width.to_string(),
                        case.height.to_string(),
                    ])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                if let Some(id) = id {
                    let _ = std::process::Command::new("/usr/sbin/screencapture")
                        .args(["-x", "-o", "-l", &id, &path])
                        .status();
                }
            }
            let _ = cx.update(|cx| handle.update(cx, |_, window, _| window.remove_window()));
        }
        if only_one {
            let _ = cx.update(|cx| cx.quit());
            return;
        }
        // The Appearance window, with no server: Default, nothing to change.
        let bounds = Bounds::new(point(px(40.), px(60.)), size(px(760.), px(800.)));
        let opened = cx.update(|cx| {
            let store = shouldertap_core::ReceiverStore::new(shouldertap_core::StoreConfig {
                endpoints: shouldertap_core::Endpoints {
                    server: "http://127.0.0.1:9".into(),
                    web: "http://127.0.0.1:9".into(),
                },
                persistence: Box::new(shouldertap_core::LocalPersistence::new(
                    std::env::temp_dir().join("shouldertap-snapshots"),
                    None,
                )),
                transport: std::sync::Arc::new(shouldertap_core::NetworkTransport::default()),
                ack_retry_delay: Duration::from_secs(10),
            });
            let senders = shouldertap_core::SenderStore::new(shouldertap_core::SenderConfig {
                server: "http://127.0.0.1:9".into(),
                persistence: Box::new(shouldertap_core::LocalSenderPersistence::new(
                    std::env::temp_dir().join("shouldertap-snapshots"),
                    None,
                )),
                transport: std::sync::Arc::new(shouldertap_core::NetworkTransport::default()),
            });
            let account = shouldertap_core::AccountStore::new(shouldertap_core::AccountConfig {
                server: "http://127.0.0.1:9".into(),
                vault: Box::new(shouldertap_core::FileVault::new(
                    std::env::temp_dir().join("shouldertap-snapshots/account.secret"),
                )),
                transport: std::sync::Arc::new(shouldertap_core::NetworkTransport::default()),
                platform: shouldertap_core::DevicePlatform::Windows,
                device_name: Box::new(|| "Snapshot".into()),
                receiver: store.clone(),
                senders: senders.clone(),
            });
            let patron = shouldertap_core::PatronStore::new(shouldertap_core::PatronConfig {
                account: account.clone(),
                senders: senders.clone(),
                vault: Box::new(shouldertap_core::FileVault::new(
                    std::env::temp_dir().join("shouldertap-snapshots/patron.secret"),
                )),
                persistence: Box::new(shouldertap_core::LocalPatronPersistence::new(
                    std::env::temp_dir().join("shouldertap-snapshots"),
                )),
            });
            let model = cx.new(|_| crate::shell::Model {
                state: store.state(),
                store,
                sender_state: senders.state(),
                senders,
                account_state: account.state(),
                account,
                patron_state: patron.state(),
                patron,
                updates: Default::default(),
                launch_at_login: false,
            });
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: None,
                    kind: WindowKind::PopUp,
                    focus: false,
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| crate::appearance::AppearanceView::new(model, window, cx)),
            )
        });
        if let Ok(Ok(handle)) = opened {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            if let Ok(tool) = std::env::var("SHOULDERTAP_WINDOW_ID_TOOL")
                && let Some(id) = std::process::Command::new(tool)
                    .args([std::process::id().to_string(), "760".into(), "800".into()])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            {
                let path = format!("{directory}/appearance-window.png");
                let _ = std::process::Command::new("/usr/sbin/screencapture")
                    .args(["-x", "-o", "-l", &id, &path])
                    .status();
            }
            let _ = cx.update(|cx| handle.update(cx, |_, window, _| window.remove_window()));
        }
        patron_shots(&directory, cx).await;
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

/// The patron surfaces with no server: the welcome's Patron step, the Send
/// window's Style row and nudge, and the Tap style sheet.
async fn patron_shots(directory: &str, cx: &mut gpui::AsyncApp) {
    use shouldertap_core::{Patron, PatronSettings, PatronState};

    use crate::send::{SendTarget, SendView};
    use crate::welcome::{WelcomeStep, WelcomeView};

    let not_yet = PatronState {
        settings: PatronSettings {
            sent: 5,
            ..PatronSettings::default()
        },
        checkout_enabled: true,
        loaded: true,
        ..PatronState::default()
    };
    let patron = PatronState {
        settings: PatronSettings {
            theme: TapTheme::Note,
            sent: 30,
            nudges_shown: 1,
        },
        active: true,
        checkout_enabled: true,
        has_key: true,
        membership: Some(Patron {
            active: true,
            status: "active".into(),
            paid_until: Some(1_824_465_600_000.),
            can_manage: true,
            can_subscribe: false,
            legacy_supporter: false,
        }),
        loaded: true,
    };
    let shots: Vec<(&str, f32, f32, PatronState, Option<(bool, Option<TapTheme>)>)> = vec![
        ("patron-welcome", 520., 900., not_yet.clone(), None),
        ("patron-send-row", 520., 760., not_yet.clone(), Some((false, None))),
        ("patron-send-nudge", 520., 900., not_yet.clone(), Some((true, None))),
        (
            "patron-style-sheet",
            520.,
            1180.,
            not_yet,
            Some((false, Some(TapTheme::Broadsheet))),
        ),
        (
            "patron-send-row-patron",
            520.,
            760.,
            patron.clone(),
            Some((false, None)),
        ),
        (
            "patron-style-sheet-patron",
            520.,
            1180.,
            patron,
            Some((false, Some(TapTheme::Note))),
        ),
    ];
    for (name, width, height, patron_state, send) in shots {
        let bounds = Bounds::new(point(px(40.), px(60.)), size(px(width), px(height)));
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: None,
            kind: WindowKind::PopUp,
            focus: false,
            ..Default::default()
        };
        let opened = cx.update(|cx| {
            let model = snapshot_model(name, patron_state, cx);
            match send {
                None => cx
                    .open_window(options, |_, cx| {
                        cx.new(|cx| WelcomeView::new(model, WelcomeStep::Patron, cx))
                    })
                    .map(gpui::AnyWindowHandle::from),
                Some((sent, style)) => cx
                    .open_window(options, |window, cx| {
                        cx.new(|cx| {
                            let mut view = SendView::new(model, SendTarget::Person("s1s1s1s1".into()), window, cx);
                            view.snapshot(sent, style);
                            view
                        })
                    })
                    .map(gpui::AnyWindowHandle::from),
            }
        });
        let Ok(Ok(handle)) = opened else { continue };
        cx.background_executor().timer(Duration::from_millis(1500)).await;
        capture(directory, name, width, height);
        let _ = cx.update(|cx| handle.update(cx, |_, window, _| window.remove_window()));
    }
}

/// Signed in as Rosa, who can tap Jamie, with no server behind it.
fn snapshot_model(
    name: &str,
    patron_state: shouldertap_core::PatronState,
    cx: &mut App,
) -> Entity<crate::shell::Model> {
    use shouldertap_core::*;
    let directory = std::env::temp_dir().join(format!("shouldertap-snapshots-{name}"));
    let _ = std::fs::remove_dir_all(&directory);
    let server = "http://127.0.0.1:9".to_string();
    let transport = std::sync::Arc::new(NetworkTransport::default());
    let pairings = LocalSenderPersistence::new(directory.clone(), None);
    let _ = pairings.save_pairing(&SenderPairing {
        token: "inbox123.s1s1s1s1.secret5678".into(),
        credential_id: "s1s1s1s1".into(),
        recipient_name: "Jamie".into(),
        sender_name: "Rosa".into(),
        color: Some(PersonColor::Tomato),
        paired_at: 1.0,
        account_id: None,
        theme: None,
        choose_seen_as: false,
    });
    let store = ReceiverStore::new(StoreConfig {
        endpoints: Endpoints {
            server: server.clone(),
            web: server.clone(),
        },
        persistence: Box::new(LocalPersistence::new(directory.clone(), None)),
        transport: transport.clone(),
        ack_retry_delay: Duration::from_secs(10),
    });
    let senders = SenderStore::new(SenderConfig {
        server: server.clone(),
        persistence: Box::new(pairings),
        transport: transport.clone(),
    });
    senders.start();
    let account = AccountStore::new(AccountConfig {
        server,
        vault: Box::new(FileVault::new(directory.join("account.secret"))),
        transport,
        platform: DevicePlatform::Windows,
        device_name: Box::new(|| "Snapshot".into()),
        receiver: store.clone(),
        senders: senders.clone(),
    });
    let patron = PatronStore::new(PatronConfig {
        account: account.clone(),
        senders: senders.clone(),
        vault: Box::new(FileVault::new(directory.join("patron.secret"))),
        persistence: Box::new(LocalPatronPersistence::new(directory)),
    });
    let mut account_state = account.state();
    account_state.signed_in = true;
    cx.new(|_| crate::shell::Model {
        state: store.state(),
        store,
        sender_state: senders.state(),
        senders,
        account_state,
        account,
        patron_state,
        patron,
        updates: Default::default(),
        launch_at_login: false,
    })
}

/// This window only, by id (a helper lists this process's windows), never
/// whatever else is on screen.
fn capture(directory: &str, name: &str, width: f32, height: f32) {
    let Ok(tool) = std::env::var("SHOULDERTAP_WINDOW_ID_TOOL") else {
        return;
    };
    let id = std::process::Command::new(tool)
        .args([std::process::id().to_string(), width.to_string(), height.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(id) = id {
        let path = format!("{directory}/{name}.png");
        let _ = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-x", "-o", "-l", &id, &path])
            .status();
    }
}
