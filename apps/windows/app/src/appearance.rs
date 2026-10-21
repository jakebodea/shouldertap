//! The Appearance window, ported from apps/macos's Appearance.swift: pick how
//! taps look on this inbox's computers, with a live preview drawn by the real
//! theme code. Settings live on the server, so every computer follows.

use std::rc::Rc;
use std::time::Instant;

use gpui::{AnyElement, App, Context, Entity, FontWeight, Render, Subscription, Window, div, prelude::*, px};
use shouldertap_core::{
    ActiveTap, ApiError, CredentialKind, ErrorCode, MotionPreference, PersonColor, Tap, TapState, TapTheme,
    UpdateAppearance, now_ms,
};

use crate::menu::{Kind, error_text, menu_button, muted};
use crate::overlay::reply_placeholder;
use crate::platform;
use crate::shell::{Model, Shell};
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme::Surface;
use crate::themes::{self, Act, Actions, Scene};

const PREVIEW_W: f32 = 716.;
const PREVIEW_H: f32 = 716. * 900. / 1440.;

pub struct AppearanceView {
    model: Entity<Model>,
    previewing: TapTheme,
    sender: Option<String>,
    arrived_at: Instant,
    replying: bool,
    reply: Entity<TextField>,
    busy: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl AppearanceView {
    pub fn new(model: Entity<Model>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = model.read(cx).state.clone();
        let previewing = state.theme_on_screen(now_ms());
        let reply = cx.new(|cx| TextField::new(cx, "", 280));
        let subscriptions = vec![
            cx.observe(&model, |_, _, cx| cx.notify()),
            cx.subscribe_in(&reply, window, |this, _, event, window, cx| match event {
                TextFieldEvent::Submit => this.act(Act::Send, window, cx),
                TextFieldEvent::Cancel => this.act(Act::Back, window, cx),
                TextFieldEvent::Changed => cx.notify(),
            }),
        ];
        let mut view = Self {
            model,
            previewing,
            sender: None,
            arrived_at: Instant::now(),
            replying: false,
            reply,
            busy: false,
            error: None,
            _subscriptions: subscriptions,
        };
        view.replay(cx);
        view
    }

    /// A tap from someone who can tap you, with their latest message, or a
    /// sample when nobody has yet.
    fn sample(&self, cx: &App) -> ActiveTap {
        let state = &self.model.read(cx).state;
        let people: Vec<_> = state
            .credentials
            .iter()
            .filter(|c| c.kind == CredentialKind::Sender)
            .collect();
        let person = people
            .iter()
            .find(|p| Some(&p.id) == self.sender.as_ref())
            .or(people.first())
            .copied();
        let latest = person.and_then(|p| state.taps.iter().find(|t| t.sender_id == p.id));
        ActiveTap {
            tap: Tap {
                id: "preview".into(),
                sender_id: person.map(|p| p.id.clone()).unwrap_or_else(|| "sample".into()),
                sender_name: person.map(|p| p.name.clone()).unwrap_or_else(|| "Maya".into()),
                sender_color: person.and_then(|p| p.color).unwrap_or(PersonColor::Moss),
                body: latest
                    .map(|t| t.body.clone())
                    .unwrap_or_else(|| "Dinner's ready. Come down whenever you hit a stopping point.".into()),
                created_at: now_ms() - 120_000.,
                state: TapState::Pending,
                displayed_at: None,
                acknowledged_at: None,
                acknowledged_by: None,
                response: None,
                sequence: 0,
            },
            queued: 1,
        }
    }

    fn replay(&mut self, cx: &mut Context<Self>) {
        self.arrived_at = Instant::now();
        self.replying = false;
        let sample = self.sample(cx);
        let (placeholder, caret) = themes::reply_colors(self.previewing, sample.tap.sender_color);
        let theme = self.previewing;
        self.reply.update(cx, |field, cx| {
            field.clear(cx);
            field.set_placeholder(reply_placeholder(theme, &sample));
            field.set_colors(placeholder, caret);
        });
        cx.notify();
    }

    /// The preview answers nothing; answering plays the arrival again.
    fn act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        match act {
            Act::Reply => {
                self.replying = true;
                window.focus(&gpui::Focusable::focus_handle(self.reply.read(cx), cx));
                cx.notify();
            }
            Act::Back => {
                self.replying = false;
                cx.notify();
            }
            Act::OnIt | Act::In10 | Act::Send => self.replay(cx),
        }
    }

    fn save(&mut self, update: UpdateAppearance, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        let store = self.model.read(cx).store.clone();
        let task = cx
            .background_executor()
            .spawn(async move { store.update_appearance(update) });
        cx.spawn(async move |this, cx| {
            let result: Result<(), ApiError> = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                if let Err(error) = result {
                    this.error = Some(error.message);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_billing(&mut self, manage: bool, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        let store = self.model.read(cx).store.clone();
        let task = cx.background_executor().spawn(async move {
            if manage {
                store.manage_patron_url()
            } else {
                store.checkout_url()
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(url) => cx.open_url(&url),
                    Err(error) if error.code == ErrorCode::Conflict => this.error = Some(error.message),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn subtitle(theme: TapTheme) -> &'static str {
        match theme {
            TapTheme::Default => "The calm Frame · free",
            TapTheme::Broadsheet => "Front-page serif",
            TapTheme::Billboard => "Poster in their color",
            TapTheme::Terminal => "Phosphor console",
            TapTheme::Note => "Handwritten, taped down",
        }
    }
}

impl Render for AppearanceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let s = Surface::new(platform::is_dark(window));
        let state = self.model.read(cx).state.clone();
        let appearance = state.appearance;
        let on_screen = state.theme_on_screen(now_ms());
        let system_reduce = platform::reduce_motion();
        let reduce = appearance.reduces_motion(system_reduce);

        let elapsed = self.arrived_at.elapsed().as_secs_f32();
        let sample = self.sample(cx);
        if themes::arriving(self.previewing, &sample.tap.body, elapsed, reduce) {
            window.request_animation_frame();
        }
        let this = cx.entity().downgrade();
        let actions: Actions = Rc::new(move |act, window, cx| {
            let _ = this.update(cx, |this, cx| this.act(act, window, cx));
        });
        let scene = Scene {
            theme: self.previewing,
            active: sample,
            replying: self.replying,
            reply: self.reply.clone(),
            reply_empty: self.reply.read(cx).text().trim().is_empty(),
            width: PREVIEW_W,
            height: PREVIEW_H,
            elapsed,
            reduce,
            actions,
            frame_scale: Some(PREVIEW_W / 1440.),
        };
        let preview = div()
            .w(px(PREVIEW_W))
            .h(px(PREVIEW_H))
            .rounded(px(10.))
            .overflow_hidden()
            .border_1()
            .border_color(s.separator)
            .child(themes::render(&scene, window, cx));

        let people: Vec<_> = state
            .credentials
            .iter()
            .filter(|c| c.kind == CredentialKind::Sender)
            .cloned()
            .collect();
        let chosen = self.sender.clone().or(people.first().map(|p| p.id.clone()));
        let mut senders = div().flex().flex_row().items_center().gap(px(8.));
        if !people.is_empty() {
            senders = senders.child(div().text_size(px(12.)).text_color(s.secondary).child("Preview as"));
        }
        for person in people {
            let id = person.id.clone();
            let selected = chosen.as_ref() == Some(&person.id);
            let color = person.color.unwrap_or(PersonColor::Moss);
            senders = senders.child(
                div()
                    .id(gpui::SharedString::from(format!("sender-{}", person.id)))
                    .size(px(28.))
                    .rounded_full()
                    .p(px(3.))
                    .border_1()
                    .border_color(if selected { s.primary } else { gpui::transparent_black() })
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.sender = Some(id.clone());
                        this.replay(cx);
                    }))
                    .child(
                        div()
                            .size_full()
                            .rounded_full()
                            .bg(crate::theme::base(color))
                            .text_color(crate::theme::ink(color))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(11.))
                            .font_weight(FontWeight::BOLD)
                            .child(
                                person
                                    .name
                                    .chars()
                                    .next()
                                    .map(|c| c.to_uppercase().to_string())
                                    .unwrap_or_default(),
                            ),
                    ),
            );
        }
        let replay = menu_button(s, "replay", "Replay", None, Kind::Secondary, false, false)
            .on_click(cx.listener(|this, _, _, cx| this.replay(cx)));
        let top_row = div()
            .flex()
            .flex_row()
            .items_center()
            .child(senders)
            .child(div().flex_1())
            .child(replay);

        let mut cards = div().flex().flex_row().gap(px(8.));
        for theme in TapTheme::ALL {
            let selected = theme == self.previewing;
            cards = cards.child(
                div()
                    .id(theme.label())
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(8.))
                    .bg(s.card)
                    .border_1()
                    .border_color(if selected { s.primary } else { s.separator })
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.previewing = theme;
                        this.replay(cx);
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .justify_between()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(theme.label())
                            .when(theme == on_screen, |d| {
                                d.child(div().text_color(crate::theme::live_green()).child("●"))
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(s.secondary)
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(Self::subtitle(theme)),
                    ),
            );
        }

        let previewing = self.previewing;
        let decision: AnyElement = if previewing == on_screen {
            muted(s, "● On your screens").into_any_element()
        } else if previewing == TapTheme::Default || appearance.can_choose_theme {
            menu_button(
                s,
                "use",
                &if self.busy {
                    "Saving…".to_string()
                } else {
                    format!("Use {}", previewing.label())
                },
                None,
                Kind::Primary,
                false,
                self.busy || !state.appearance_supported,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.save(
                    UpdateAppearance {
                        theme: Some(previewing),
                        motion: None,
                    },
                    cx,
                )
            }))
            .into_any_element()
        } else {
            let patron = state.patron.clone();
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(muted(
                    s,
                    "Themes other than Default come with patron support while it's active. Default and everything else stay free.",
                ))
                .when(patron.as_ref().is_some_and(|p| p.can_subscribe), |d| {
                    d.child(
                        menu_button(s, "subscribe", "Become a patron · $24/year…", None, Kind::Secondary, false, self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.open_billing(false, cx))),
                    )
                })
                .when(patron.as_ref().is_some_and(|p| p.can_manage && !p.can_subscribe), |d| {
                    d.child(
                        menu_button(s, "manage", "Manage support…", None, Kind::Secondary, false, self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.open_billing(true, cx))),
                    )
                })
                .into_any_element()
        };
        let lapsed = (appearance.theme != TapTheme::Default && on_screen == TapTheme::Default).then(|| {
            muted(
                s,
                &format!(
                    "{} is saved and comes back while patron support is active. Until then your screens show Default.",
                    appearance.theme.label()
                ),
            )
        });

        let motion_button = |id: &'static str, label: &'static str, value: MotionPreference, cx: &mut Context<Self>| {
            menu_button(
                s,
                id,
                label,
                None,
                if appearance.motion == value {
                    Kind::Primary
                } else {
                    Kind::Secondary
                },
                false,
                self.busy || !state.appearance_supported,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.save(
                    UpdateAppearance {
                        theme: None,
                        motion: Some(value),
                    },
                    cx,
                )
            }))
        };
        let motion = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Motion"))
                    .child(motion_button(
                        "follow-system",
                        "Follow system",
                        MotionPreference::System,
                        cx,
                    ))
                    .child(motion_button(
                        "always-reduce",
                        "Always reduce",
                        MotionPreference::Reduced,
                        cx,
                    )),
            )
            .child(muted(
                s,
                if system_reduce {
                    "Windows' animation effects are off, so taps fade in calmly."
                } else {
                    "Arrivals settle in about a second. Always reduce makes them a short fade on every computer."
                },
            ));

        div()
            .size_full()
            .bg(s.background)
            .text_color(s.primary)
            .text_size(px(13.))
            .p(px(22.))
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(17.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("How taps look on your computers"),
                    )
                    .child(muted(
                        s,
                        "Only you choose this. People who tap you can't change it, and it never changes what they see.",
                    )),
            )
            .child(preview)
            .child(top_row)
            .child(cards)
            .child(decision)
            .children(lapsed)
            .child(div().h(px(1.)).bg(s.separator))
            .child(motion)
            .when(!state.appearance_supported, |d| {
                d.child(muted(
                    s,
                    "This server doesn't support appearance settings yet. Taps show in Default.",
                ))
            })
            .when_some(self.error.clone(), |d, error| d.child(error_text(s, error)))
    }
}

impl Shell {
    pub fn open_appearance(cx: &mut App) {
        Shell::close_menu(cx);
        if let Some(handle) = cx.global::<Shell>().appearance
            && handle.update(cx, |_, window, _| window.activate_window()).is_ok()
        {
            return;
        }
        let model = cx.global::<Shell>().model.clone();
        model.read(cx).store.refresh();
        let bounds = gpui::Bounds::centered(None, gpui::size(px(760.), px(800.)), cx);
        let handle = cx
            .open_window(
                gpui::WindowOptions {
                    window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Tap Appearance".into()),
                        ..Default::default()
                    }),
                    focus: true,
                    show: true,
                    is_resizable: false,
                    app_id: Some(crate::config::APP_ID.into()),
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| AppearanceView::new(model, window, cx)),
            )
            .ok();
        if let Some(handle) = handle {
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
        cx.global_mut::<Shell>().appearance = handle;
    }
}
