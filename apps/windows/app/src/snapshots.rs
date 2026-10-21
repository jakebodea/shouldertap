//! Development only: `SHOULDERTAP_RENDER_THEMES=<dir>` on a Mac opens each
//! theme in a real GPUI window, captures it mid-arrival and settled with
//! `screencapture`, then quits. Checks the renderers against the approved
//! mockup without a server.

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
    body: &'static str,
    width: f32,
    height: f32,
    replying: bool,
    frames: Vec<f32>,
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
            body,
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
    let queue: Vec<Case> = cases()
        .into_iter()
        .filter(|c| only.as_ref().is_none_or(|o| c.name.contains(o)))
        .collect();
    cx.spawn(async move |cx| {
        for case in queue {
            let tap = Tap {
                id: case.name.clone(),
                sender_id: "s1".into(),
                sender_name: "Maya".into(),
                sender_color: case.color,
                body: case.body.into(),
                created_at: now_ms() - 120_000.,
                state: TapState::Pending,
                displayed_at: None,
                acknowledged_at: None,
                acknowledged_by: None,
                response: None,
                sequence: 0,
                theme: Some(case.theme),
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
                        let reply = cx.new(|cx| TextField::new(cx, "Reply to Maya", 280));
                        cx.new(|_| Shot {
                            scene_theme: case.theme,
                            active: ActiveTap { tap, queued: 1 },
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
                device_name: Box::new(|| "Snapshot".into()),
                platform: shouldertap_core::DevicePlatform::Windows,
                machine: Box::new(|| None),
                transport: std::sync::Arc::new(shouldertap_core::NetworkTransport::default()),
                ack_retry_delay: Duration::from_secs(10),
            });
            let model = cx.new(|_| crate::shell::Model {
                state: store.state(),
                store,
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
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}
