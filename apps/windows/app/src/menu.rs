//! The tray menu, ported from apps/macos's MenuView.swift: a native surface,
//! so the system font and light or dark colors, with Bricolage only in the
//! "Shouldertap" title (docs/design.md, "Surfaces").

use std::collections::HashMap;

use gpui::{
    AnyElement, App, Bounds, ClickEvent, ClipboardItem, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla,
    Pixels, Render, SharedString, Subscription, Window, div, prelude::*, px, svg,
};
use shouldertap_core::{
    AccountStore, ApiError, Credential, CredentialKind, DevicePlatform, ErrorCode, LiveStatus, Patron, Phase,
    ReceiverStore, ResponseKind, SenderInvite, Tap, now_ms,
};

use crate::assets::{Icon, MARK_PATH};
use crate::config;
use crate::platform::{self, HOME_SIZE, MENU_WIDTH, TrayAnchor};
use crate::qr::qr_code;
use crate::send::{SendTarget, latest_status};
use crate::shell::{Model, Shell};
use crate::theme::{self, BRICOLAGE, Surface};
use crate::welcome::WelcomeStep;

pub const MIN_HEIGHT: f32 = 120.;
/// `confirming` while asking before deleting the account.
const DELETE_ACCOUNT: &str = "delete-account";
/// Grow with the content, and scroll past this.
const MAX_HEIGHT: f32 = 620.;

pub struct MenuView {
    model: Entity<Model>,
    anchor: Option<TrayAnchor>,
    focus: FocusHandle,
    /// The window's size, width then height: grows with the content before
    /// setup, `HOME_SIZE` once signed in.
    size: (f32, f32),
    /// Settings shows in place of the panes.
    settings: bool,
    // Account
    account_busy: bool,
    account_error: Option<String>,
    // Optional support
    support_expanded: bool,
    plan_busy: bool,
    plan_opened: bool,
    plan_error: Option<String>,
    plan_notice: Option<String>,
    // Invite someone
    invite: Option<SenderInvite>,
    invite_copied: bool,
    invite_error: Option<String>,
    // Pairings
    confirming: Option<String>,
    row_errors: HashMap<String, String>,
    _subscriptions: Vec<Subscription>,
}

impl MenuView {
    pub fn new(model: Entity<Model>, anchor: Option<TrayAnchor>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(&model, |_, _, cx| cx.notify()),
            // Like a flyout: clicking anywhere else closes it.
            cx.observe_window_activation(window, |_, window, cx| {
                if !window.is_window_active() {
                    Shell::menu_deactivated(cx);
                }
            }),
            cx.observe_window_appearance(window, |_, _, cx| cx.notify()),
        ];
        let focus = cx.focus_handle();
        window.focus(&focus);
        Self {
            model,
            anchor,
            focus,
            size: (MENU_WIDTH, MIN_HEIGHT),
            settings: false,
            account_busy: false,
            account_error: None,
            support_expanded: false,
            plan_busy: false,
            plan_opened: false,
            plan_error: None,
            plan_notice: None,
            invite: None,
            invite_copied: false,
            invite_error: None,
            confirming: None,
            row_errors: HashMap::new(),
            _subscriptions: subscriptions,
        }
    }

    fn store(&self, cx: &App) -> ReceiverStore {
        self.model.read(cx).store.clone()
    }

    /// Runs a blocking store command off the UI thread, then `done` back on it.
    fn run<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(ReceiverStore) -> Result<T, ApiError> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, ApiError>, &mut Context<Self>) + 'static,
    ) {
        let store = self.store(cx);
        let task = cx.background_executor().spawn(async move { work(store) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                done(this, result, cx);
                cx.notify();
            });
        })
        .detach();
    }

    // Account

    /// Runs a blocking account command off the UI thread, then `done` on it.
    fn run_account(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(AccountStore) -> Result<(), ApiError> + Send + 'static,
        done: impl FnOnce(&mut Self, &mut Context<Self>) + 'static,
    ) {
        self.account_busy = true;
        self.account_error = None;
        let account = self.model.read(cx).account.clone();
        let task = cx.background_executor().spawn(async move { work(account) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.account_busy = false;
                match result {
                    Ok(()) => done(this, cx),
                    Err(error) => this.account_error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        // A failed sync shows in the account's own state.
        let account = self.model.read(cx).account.clone();
        self.account_busy = true;
        let task = cx.background_executor().spawn(async move { account.sync() });
        cx.spawn(async move |this, cx| {
            let _ = task.await;
            let _ = this.update(cx, |this, cx| {
                this.account_busy = false;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn sign_out(&mut self, cx: &mut Context<Self>) {
        self.run_account(cx, |account| account.sign_out(), |_, _| {});
    }

    fn delete_account(&mut self, cx: &mut Context<Self>) {
        self.run_account(cx, |account| account.delete_account(), |this, _| this.confirming = None);
    }

    // Plan

    /// Opens the billing portal for earlier receiver-owned support. Nothing is
    /// sold here: patron support belongs to senders now.
    fn manage_support(&mut self, cx: &mut Context<Self>) {
        self.plan_busy = true;
        self.plan_error = None;
        self.plan_notice = None;
        self.run(
            cx,
            move |store| store.manage_patron_url(),
            |this, result, cx| {
                this.plan_busy = false;
                match result {
                    Ok(url) => {
                        cx.open_url(&url);
                        this.plan_opened = true;
                    }
                    Err(error) if error.code == ErrorCode::Conflict => this.plan_notice = Some(error.message),
                    Err(error) => this.plan_error = Some(error.to_string()),
                }
            },
        );
    }

    // Pairing

    fn create_invite(&mut self, cx: &mut Context<Self>) {
        self.invite_error = None;
        self.run(
            cx,
            |store| store.create_sender_invite(),
            |this, result, _| match result {
                Ok(invite) => this.invite = Some(invite),
                Err(error) => this.invite_error = Some(error.to_string()),
            },
        );
    }

    fn delete_tap(&mut self, key: String, tap_id: String, cx: &mut Context<Self>) {
        self.run(
            cx,
            move |store| store.delete_tap(&tap_id),
            move |this, result, _| {
                if let Err(error) = result {
                    this.row_errors.insert(key, error.to_string());
                    this.confirming = None;
                }
            },
        );
    }

    fn revoke(&mut self, id: String, cx: &mut Context<Self>) {
        let target = id.clone();
        self.run(
            cx,
            move |store| store.revoke(&target),
            move |this, result, _| {
                if let Err(error) = result {
                    this.row_errors.insert(id, error.to_string());
                    this.confirming = None;
                }
            },
        );
    }

    /// Before setup the window follows its content's height, anchored to the tray.
    fn content_measured(&mut self, height: f32, window: &mut Window, cx: &mut Context<Self>) {
        let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT).ceil();
        if self.resize_to(MENU_WIDTH, height, window) {
            cx.notify();
        }
    }

    /// Resizes the window on the next frame; false when it's that size already.
    fn resize_to(&mut self, width: f32, height: f32, window: &mut Window) -> bool {
        if (width - self.size.0).abs() < 1. && (height - self.size.1).abs() < 1. {
            return false;
        }
        self.size = (width, height);
        let anchor = self.anchor;
        window.on_next_frame(move |window, cx| platform::resize_menu(window, width, height, anchor, cx));
        true
    }

    /// Signed in, named and receiving: the two panes. Anything less is setup.
    fn is_home(&self, cx: &App) -> bool {
        let model = self.model.read(cx);
        model.state.phase == Phase::Ready && model.account_state.signed_in && !model.account_state.needs_profile()
    }

    /// Esc backs out of Settings or an invite before it closes the menu.
    fn escape(&mut self, cx: &mut Context<Self>) {
        if self.settings {
            self.settings = false;
        } else if self.invite.is_some() {
            self.invite = None;
            self.invite_copied = false;
        } else {
            return Shell::close_menu(cx);
        }
        cx.notify();
    }
}

impl Focusable for MenuView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for MenuView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let s = Surface::new(platform::is_dark(window));
        let root = div()
            .id("menu")
            .track_focus(&self.focus)
            .key_context("Menu")
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    this.escape(cx);
                }
            }))
            .size_full()
            .bg(s.background)
            .text_color(s.primary)
            .text_size(px(13.));
        if self.is_home(cx) {
            self.resize_to(HOME_SIZE.0, HOME_SIZE.1, window);
            return root.child(self.home(s, cx)).into_any_element();
        }
        self.settings = false;
        let body: AnyElement = match self.model.read(cx).state.phase {
            Phase::Loading => div().h(px(120.)).into_any_element(),
            Phase::Setup | Phase::Ready => self.setup(s, cx),
        };
        let this = cx.entity();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(14.))
            .when(config::DEV, |content| content.child(debug_banner()))
            .child(body);
        root.overflow_y_scroll()
            .child(
                div()
                    .on_children_prepainted(move |bounds: Vec<Bounds<Pixels>>, window, cx| {
                        let height = bounds
                            .first()
                            .map(|bounds| f32::from(bounds.size.height))
                            .unwrap_or(MIN_HEIGHT);
                        this.update(cx, |this, cx| this.content_measured(height, window, cx));
                    })
                    .child(content),
            )
            .into_any_element()
    }
}

// Screens

impl MenuView {
    /// Before this PC is signed in, named and receiving: what to do next.
    fn setup(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let state = self.model.read(cx).state.clone();
        let receiving = state.phase == Phase::Ready;
        let subtitle = self.subtitle(cx);
        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(brand(s, &subtitle, receiving.then(|| status_label(s, state.status))))
            .children(self.next_step(s, cx))
            .child(self.footer(s, cx))
            .into_any_element()
    }

    /// "Taps for {name}", or a blank line until there's a name.
    fn subtitle(&self, cx: &App) -> String {
        let model = self.model.read(cx);
        // Billing never changes the recipient name or messaging controls.
        let name = if model.state.recipient_name.is_empty() {
            model.account_state.profile().map(|profile| profile.name.clone())
        } else {
            Some(model.state.recipient_name.clone())
        };
        name.map_or_else(|| " ".to_string(), |name| format!("Taps for {name}"))
    }

    /// Signed in: who you tap on the left, what you got on the right, and
    /// everything else behind Settings at the bottom (apps/macos's HomeView).
    fn home(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let body = if self.settings {
            self.settings_view(s, cx)
        } else {
            let main = match self.invite.clone() {
                Some(invite) => self.invite_card(s, invite, cx),
                None => div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.send_pane(s, cx))
                    .child(div().w(px(1.)).h_full().flex_none().bg(s.separator))
                    .child(self.received_pane(s, cx))
                    .into_any_element(),
            };
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .child(div().p(px(14.)).flex_none().child(self.header(s, cx)))
                .child(hairline(s))
                .child(main)
                .into_any_element()
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .when(config::DEV, |el| {
                el.child(div().px(px(14.)).pt(px(14.)).flex_none().child(debug_banner()))
            })
            .child(body)
            .child(self.bottom_bar(s, cx))
            .into_any_element()
    }

    fn header(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let status = self.model.read(cx).state.status;
        let subtitle = self.subtitle(cx);
        let inviting = self.invite.is_some();
        let trailing = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(status_label(s, status))
            .child(
                menu_button(
                    s,
                    "invite",
                    "Invite someone",
                    Some(Icon::Invite),
                    Kind::Primary,
                    false,
                    inviting,
                )
                .when(!inviting, |button| {
                    button.on_click(cx.listener(|this, _, _, cx| this.create_invite(cx)))
                }),
            )
            .into_any_element();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(brand(s, &subtitle, Some(trailing)))
            .when_some(self.invite_error.clone(), |el, error| el.child(error_text(s, error)))
            .into_any_element()
    }

    /// The people this PC can tap: each opens the Send window on them.
    fn send_pane(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let state = self.model.read(cx).sender_state.clone();
        let now = now_ms();
        let mut rows: Vec<AnyElement> = Vec::new();
        if let Some(notice) = state.notice.clone() {
            let senders = self.model.read(cx).senders.clone();
            rows.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(muted(s, &notice).flex_1())
                    .child(
                        menu_button(s, "dismiss-notice", "OK", None, Kind::Plain, false, false)
                            .on_click(move |_, _, _| senders.clear_notice()),
                    )
                    .into_any_element(),
            );
        }
        if state.sessions.is_empty() {
            rows.push(
                muted(
                    s,
                    "No one to tap yet. When someone sends you an invite link, paste it below.",
                )
                .pt(px(4.))
                .into_any_element(),
            );
        }
        for session in &state.sessions {
            let id = session.id().to_string();
            rows.push(
                row(s, SharedString::from(format!("tap-person-{id}")))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| Shell::open_send(SendTarget::Person(id.clone()), cx))
                    .child(avatar(&session.pairing.recipient_name, session.color(), 26.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .child(session.pairing.recipient_name.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(s.secondary)
                                    .truncate()
                                    .child(latest_status(session, now)),
                            ),
                    )
                    .child(div().text_color(s.tertiary).child("›"))
                    .into_any_element(),
            );
        }
        let foot = row(s, "add-tap-person")
            .cursor_pointer()
            .on_click(|_, _, cx| Shell::open_send(SendTarget::Add, cx))
            .child(glyph(s, Icon::Send))
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(s.secondary)
                    .child("Got a link? Paste it"),
            )
            .into_any_element();
        pane("send", "Send", None, rows, Some(foot)).into_any_element()
    }

    /// Taps you got, newest first; who can tap you as avatars by the title.
    fn received_pane(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let state = self.model.read(cx).state.clone();
        let people: Vec<Credential> = state
            .credentials
            .iter()
            .filter(|c| c.kind == CredentialKind::Sender)
            .cloned()
            .collect();
        let trailing = (!people.is_empty()).then(|| {
            div()
                .id("can-tap-you")
                .flex()
                .items_center()
                .gap(px(3.))
                .cursor_pointer()
                .children(
                    people
                        .iter()
                        .take(5)
                        .map(|person| avatar(&person.name, person.swatch_color(), 20.)),
                )
                .when(people.len() > 5, |el| {
                    el.child(
                        div()
                            .text_size(px(11.))
                            .text_color(s.secondary)
                            .child(format!("+{}", people.len() - 5)),
                    )
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.settings = true;
                    cx.notify();
                }))
                .into_any_element()
        });
        let rows: Vec<AnyElement> = if state.taps.is_empty() {
            vec![
                muted(
                    s,
                    if people.is_empty() {
                        "No one can tap you yet. Invite someone, and they can once they accept."
                    } else {
                        "Taps you receive show up here."
                    },
                )
                .pt(px(4.))
                .into_any_element(),
            ]
        } else {
            state.taps.iter().take(30).map(|tap| self.tap_row(s, tap, cx)).collect()
        };
        pane("received", "Received", trailing, rows, None).into_any_element()
    }

    /// Everything you set once: who can tap you, devices, motion, account, app.
    fn settings_view(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let state = self.model.read(cx).state.clone();
        let mut people: Vec<AnyElement> = Vec::new();
        let mut devices: Vec<AnyElement> = Vec::new();
        for credential in &state.credentials {
            match credential.kind {
                CredentialKind::Sender => people.push(self.pairing_row(s, credential, false, cx)),
                CredentialKind::Device => {
                    let is_self = Some(&credential.id) == state.credential_id.as_ref();
                    devices.push(self.pairing_row(s, credential, is_self, cx));
                }
            }
        }
        if people.is_empty() {
            people.push(
                muted(s, "No one yet. Invite someone, and they can tap you once they accept.").into_any_element(),
            );
        }
        let back = div()
            .id("settings-back")
            .flex()
            .items_center()
            .gap(px(4.))
            .cursor_pointer()
            .child(svg().path(Icon::Back.path()).size(px(15.)).text_color(s.primary))
            .child(div().font_weight(FontWeight::SEMIBOLD).child("Settings"))
            .on_click(cx.listener(|this, _, _, cx| {
                this.settings = false;
                cx.notify();
            }));
        let appearance = self.appearance_row(s, &state, cx);
        let account = self.account_section(s, cx);
        let app = vec![self.launch_at_login(s, cx), self.check_updates(s, cx)];
        let support = self.support(s, state.patron.as_ref(), cx);
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(44.))
                    .px(px(14.))
                    .flex_none()
                    .child(back),
            )
            .child(hairline(s))
            .child(
                div().id("settings").flex_1().min_h_0().overflow_y_scroll().child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(18.))
                        .p(px(14.))
                        .child(section(s, "Can tap you", people))
                        .child(section(s, "Your devices", devices))
                        .child(section(s, "Accessibility", vec![appearance]))
                        .child(account)
                        .child(section(s, "App", app))
                        .child(support),
                ),
            )
            .into_any_element()
    }

    /// Settings, an update when there is one, and Quit.
    fn bottom_bar(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let updates = self.model.read(cx).updates.clone();
        let update_label = match (&updates.available, updates.installing) {
            (_, true) => Some("Installing…".to_string()),
            (Some(version), false) => Some(format!("Update to {version}")),
            (None, false) => None,
        };
        div()
            .flex_none()
            .flex()
            .flex_col()
            .child(hairline(s))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(10.))
                    .h(px(40.))
                    .child(
                        menu_button(
                            s,
                            "settings",
                            if self.settings { "Done" } else { "Settings" },
                            None,
                            Kind::Plain,
                            false,
                            false,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settings = !this.settings;
                            cx.notify();
                        })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .when_some(updates.message.clone(), |el, message| {
                                el.child(muted(s, &message).truncate())
                            }),
                    )
                    .when_some(update_label, |el, label| {
                        el.child(
                            menu_button(s, "update", &label, None, Kind::Secondary, false, updates.installing)
                                .when(!updates.installing, |button| {
                                    button.on_click(cx.listener(|_, _, _, cx| Shell::install_update(cx)))
                                }),
                        )
                    })
                    .child(
                        menu_button(s, "quit", "Quit", None, Kind::Plain, false, false).on_click(|_, _, cx| cx.quit()),
                    ),
            )
            .into_any_element()
    }

    /// What this PC still needs from the person or the account, if anything.
    fn next_step(&mut self, s: Surface, cx: &mut Context<Self>) -> Option<AnyElement> {
        let model = self.model.read(cx);
        let account = model.account_state.clone();
        let receiving = model.state.phase == Phase::Ready;
        let tapping = !model.sender_state.sessions.is_empty();
        let prompt = |text: &str, id: &'static str, label: &str, kind: Kind, step: WelcomeStep| {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(muted(s, text))
                .child(
                    menu_button(s, id, label, None, kind, true, false)
                        .on_click(move |_, _, cx| Shell::open_welcome(step, cx)),
                )
                .into_any_element()
        };
        if !account.signed_in {
            return Some(if receiving || tapping {
                prompt(
                    "Sign in with your email to keep your people on every device.",
                    "sign-in",
                    "Sign in",
                    Kind::Secondary,
                    WelcomeStep::Email,
                )
            } else {
                prompt(
                    "People you trust can tap you on the shoulder. Their message covers your screens until you answer, and they see your reply right away.",
                    "get-started",
                    "Get started",
                    Kind::Primary,
                    WelcomeStep::Welcome,
                )
            });
        }
        if account.needs_profile() {
            return Some(prompt(
                "Pick your name and color to finish setting up.",
                "finish-setup",
                "Finish setting up",
                Kind::Primary,
                WelcomeStep::You,
            ));
        }
        let error = account.sync_error.clone();
        if receiving && error.is_none() {
            return None;
        }
        let status = match (&error, account.me.is_some()) {
            (Some(error), _) => error_text(s, error.clone()).into_any_element(),
            (None, false) => muted(s, "Loading your account…").into_any_element(),
            (None, true) => muted(s, "Setting up this PC…").into_any_element(),
        };
        let busy = self.account_busy;
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(status)
                .when(error.is_some(), |el| {
                    el.child(
                        menu_button(
                            s,
                            "sync-again",
                            if busy { "Trying…" } else { "Try again" },
                            None,
                            Kind::Secondary,
                            true,
                            busy,
                        )
                        .when(!busy, |button| {
                            button.on_click(cx.listener(|this, _, _, cx| this.sync(cx)))
                        }),
                    )
                })
                .into_any_element(),
        )
    }

    /// The email this PC is signed in with, signing out and deleting the
    /// account. Neither touches the people this PC is connected to.
    fn account_section(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let email = self.model.read(cx).account_state.email.clone().unwrap_or_default();
        let busy = self.account_busy;
        let confirming = self.confirming.as_deref() == Some(DELETE_ACCOUNT);
        let mut rows: Vec<AnyElement> = vec![
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(email),
                )
                .child(
                    menu_button(s, "sign-out", "Sign out", None, Kind::Plain, false, busy).when(!busy, |button| {
                        button.on_click(cx.listener(|this, _, _, cx| this.sign_out(cx)))
                    }),
                )
                .child(
                    menu_button(s, "delete-account", "Delete account", None, Kind::Plain, false, busy).when(
                        !busy,
                        |button| {
                            button.on_click(cx.listener(|this, _, _, cx| {
                                this.account_error = None;
                                this.confirming = Some(DELETE_ACCOUNT.into());
                                cx.notify();
                            }))
                        },
                    ),
                )
                .into_any_element(),
        ];
        if confirming {
            rows.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(muted(
                        s,
                        "Deletes your account and signs out. This PC keeps receiving and tapping the people it's connected to.",
                    ))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(
                                menu_button(
                                    s,
                                    "confirm-delete-account",
                                    if busy { "Deleting…" } else { "Delete account" },
                                    None,
                                    Kind::Danger,
                                    false,
                                    busy,
                                )
                                .when(!busy, |button| {
                                    button.on_click(cx.listener(|this, _, _, cx| this.delete_account(cx)))
                                }),
                            )
                            .child(
                                menu_button(s, "cancel-delete-account", "Cancel", None, Kind::Plain, false, false)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.confirming = None;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .into_any_element(),
            );
        }
        if let Some(error) = self.account_error.clone() {
            rows.push(error_text(s, error).into_any_element());
        }
        // Signed in and receiving, a failed sync shows here rather than over the panes.
        if let Some(error) = self.model.read(cx).account_state.sync_error.clone() {
            rows.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().flex_1().child(error_text(s, error)))
                    .child(
                        menu_button(s, "sync-again", "Try again", None, Kind::Plain, false, busy)
                            .when(!busy, |button| {
                                button.on_click(cx.listener(|this, _, _, cx| this.sync(cx)))
                            }),
                    )
                    .into_any_element(),
            );
        }
        section(s, "Account", rows).into_any_element()
    }

    /// Opens the Appearance window; shows what taps look like right now.
    fn appearance_row(
        &mut self,
        s: Surface,
        state: &shouldertap_core::StoreState,
        _cx: &mut Context<Self>,
    ) -> AnyElement {
        row(s, "appearance")
            .cursor_pointer()
            .on_click(|_, _, cx| Shell::open_appearance(cx))
            .child(div().flex_1().font_weight(FontWeight::MEDIUM).child("Tap motion"))
            .child(div().text_size(px(12.)).text_color(s.secondary).child(format!(
                "{} ›",
                if state.appearance.motion == shouldertap_core::MotionPreference::Reduced {
                    "Reduced"
                } else {
                    "Follow system"
                }
            )))
            .into_any_element()
    }

    fn support(&mut self, s: Surface, patron: Option<&Patron>, cx: &mut Context<Self>) -> AnyElement {
        if !self.support_expanded {
            return menu_button(
                s,
                "show-support",
                "Support Shouldertap",
                None,
                Kind::Plain,
                false,
                false,
            )
            .on_click(cx.listener(|this, _, _, cx| {
                this.support_expanded = true;
                cx.notify();
            }))
            .into_any_element();
        }
        let mut actions: Vec<AnyElement> = vec![];
        actions.push(
            menu_button(
                s,
                "hide-support",
                "Close support details",
                None,
                Kind::Plain,
                false,
                false,
            )
            .on_click(cx.listener(|this, _, _, cx| {
                this.support_expanded = false;
                cx.notify();
            }))
            .into_any_element(),
        );
        if patron.is_some_and(|p| p.can_manage) {
            actions.push(
                menu_button(
                    s,
                    "manage-support",
                    "Manage or cancel earlier support",
                    None,
                    Kind::Plain,
                    false,
                    self.plan_busy,
                )
                .on_click(cx.listener(|this, _, _, cx| this.manage_support(cx)))
                .into_any_element(),
            );
        }
        div().flex().flex_col().gap(px(6.))
            .child(div().font_weight(FontWeight::SEMIBOLD).child("Patron themes"))
            .child(muted(s, "Shouldertap is free to receive and answer. Patron support belongs to the people who tap you: it lets them send their taps in a style, to everyone they tap. You never pay to see it."))
            .children(actions).children(self.plan_messages(s)).into_any_element()
    }

    fn plan_messages(&self, s: Surface) -> Option<AnyElement> {
        if let Some(error) = &self.plan_error {
            Some(error_text(s, error.clone()).into_any_element())
        } else if let Some(notice) = &self.plan_notice {
            Some(muted(s, notice).into_any_element())
        } else if self.plan_opened {
            Some(muted(s, "Manage or cancel it in your browser.").into_any_element())
        } else {
            None
        }
    }

    /// A fresh invite in place of the panes: QR, link, Copy, Done.
    fn invite_card(&mut self, s: Surface, invite: SenderInvite, cx: &mut Context<Self>) -> AnyElement {
        let url = invite.url.clone();
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .p(px(14.))
            .child(qr_code(&invite.url, px(176.)))
            .child(div().w(px(360.)).child(muted_center(
                s,
                "Scan with their iPhone camera, or send them the link to open on their phone or computer. It works once and expires in 7 days.",
            )))
            .child(div().w(px(360.)).child(mono(s, &invite.url)))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        menu_button(
                            s,
                            "copy-link",
                            if self.invite_copied { "Copied" } else { "Copy link" },
                            Some(Icon::Copy),
                            Kind::Primary,
                            false,
                            false,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                            this.invite_copied = true;
                            cx.notify();
                        })),
                    )
                    .child(
                        menu_button(s, "invite-done", "Done", None, Kind::Plain, false, false).on_click(cx.listener(
                            |this, _, _, cx| {
                                this.invite = None;
                                this.invite_copied = false;
                                cx.notify();
                            },
                        )),
                    ),
            )
            .into_any_element()
    }

    /// A tap you got, with a delete button on hover (for everyone).
    fn tap_row(&mut self, s: Surface, tap: &Tap, cx: &mut Context<Self>) -> AnyElement {
        let (icon, label) = match &tap.response {
            Some(response) => (
                Some(match response.kind {
                    ResponseKind::OnIt => Icon::OnIt,
                    ResponseKind::In10 => Icon::In10,
                    ResponseKind::Text => Icon::Reply,
                }),
                response.label(),
            ),
            None => (None, "Waiting for you".to_string()),
        };
        // Taps and pairings share `confirming` and `row_errors`.
        let key = format!("tap-{}", tap.id);
        let error = self.row_errors.get(&key).cloned();
        let group: SharedString = format!("row-{key}").into();
        let (confirm_key, tap_id) = (key.clone(), tap.id.clone());
        let trailing = self.remove_control(
            s,
            key.clone(),
            group.clone(),
            "Delete",
            move |this, cx| this.delete_tap(confirm_key.clone(), tap_id.clone(), cx),
            cx,
        );
        row(s, SharedString::from(key))
            .group(group)
            .items_start()
            .child(avatar(&tap.sender_name, tap.sender_color, 26.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .line_clamp(2)
                            .child(tap.body.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_size(px(12.))
                            .text_color(if error.is_some() { s.danger } else { s.secondary })
                            .children(
                                icon.filter(|_| error.is_none())
                                    .map(|icon| svg().path(icon.path()).size(px(13.)).text_color(s.secondary)),
                            )
                            .child(div().truncate().child(
                                error.unwrap_or_else(|| format!("{label} · {}", theme::ago(tap.created_at, now_ms()))),
                            )),
                    ),
            )
            .child(trailing)
            .into_any_element()
    }

    /// A row's remove button, shown on hover, that asks once more. `key`
    /// names the row in `confirming` and `row_errors`.
    fn remove_control(
        &mut self,
        s: Surface,
        key: String,
        group: SharedString,
        confirm_label: &'static str,
        confirm: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.confirming.as_deref() == Some(key.as_str()) {
            return div()
                .flex()
                .gap(px(8.))
                .child(
                    menu_button(s, "confirm-remove", confirm_label, None, Kind::Danger, false, false)
                        .on_click(cx.listener(move |this, _, _, cx| confirm(this, cx))),
                )
                .child(
                    menu_button(s, "cancel-remove", "Cancel", None, Kind::Plain, false, false).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.confirming = None;
                            cx.notify();
                        },
                    )),
                )
                .into_any_element();
        }
        div()
            .id(SharedString::from(format!("remove-{key}")))
            .size(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.))
            .cursor_pointer()
            .invisible()
            .group_hover(group, |style| style.visible())
            .hover(|style| style.bg(s.hover))
            .text_color(s.secondary)
            .child(svg().path(Icon::Remove.path()).size(px(16.)).text_color(s.secondary))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.row_errors.remove(&key);
                this.confirming = Some(key.clone());
                cx.notify();
            }))
            .into_any_element()
    }

    fn pairing_row(
        &mut self,
        s: Surface,
        credential: &Credential,
        is_self: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = credential.id.clone();
        let error = self.row_errors.get(&id).cloned();
        let status = error.clone().unwrap_or_else(|| pairing_status(credential, is_self));
        let leading = if credential.kind == CredentialKind::Sender {
            avatar(&credential.name, credential.swatch_color(), 26.).into_any_element()
        } else {
            glyph(s, platform_icon(credential.device_platform())).into_any_element()
        };
        let group: SharedString = format!("row-{id}").into();
        let confirm_id = id.clone();
        let trailing = self.remove_control(
            s,
            id.clone(),
            group.clone(),
            if is_self { "Unpair" } else { "Remove" },
            move |this, cx| this.revoke(confirm_id.clone(), cx),
            cx,
        );
        row(s, SharedString::from(format!("pairing-{id}")))
            .group(group)
            .child(leading)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .truncate()
                            .child(credential.name.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(if error.is_some() { s.danger } else { s.secondary })
                            .child(status),
                    ),
            )
            .child(trailing)
            .into_any_element()
    }

    /// The footer on the setup screens; once signed in these live in Settings.
    fn footer(&mut self, s: Surface, cx: &mut Context<Self>) -> impl IntoElement {
        let updates = self.model.read(cx).updates.clone();
        let update_row = updates.available.clone().map(|version| {
            row(s, "update")
                .cursor_pointer()
                .on_click(cx.listener(|_, _, _, cx| Shell::install_update(cx)))
                .child(div().w(px(26.)).flex().justify_center().child(dot(rgb_hsla(0x3a7bd5))))
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(format!("Update available: {version}")),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(s.secondary)
                        .child(if updates.installing { "Installing…" } else { "Install" }),
                )
        });
        div()
            .flex()
            .flex_col()
            .when_some(update_row, |el, row| el.child(div().pb(px(8.)).child(row)))
            .when_some(updates.message.clone(), |el, message| {
                el.child(div().pb(px(8.)).child(muted(s, &message)))
            })
            .child(div().h(px(1.)).bg(s.separator).mb(px(12.)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(div().flex_1().child(self.launch_at_login(s, cx)))
                    .child(self.check_updates(s, cx))
                    .child(
                        menu_button(s, "quit", "Quit", None, Kind::Plain, false, false).on_click(|_, _, cx| cx.quit()),
                    ),
            )
    }

    /// The "Open at login" switch and its label.
    fn launch_at_login(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let model = self.model.clone();
        let on = model.read(cx).launch_at_login;
        div()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(toggle(s, "launch-at-login", on).on_click(move |_, _, cx| {
                let enabled = !model.read(cx).launch_at_login;
                let _ = platform::set_launch_at_login(enabled);
                model.update(cx, |model, cx| {
                    model.launch_at_login = platform::launch_at_login();
                    cx.notify();
                });
            }))
            .child(div().text_size(px(12.)).text_color(s.secondary).child("Open at login"))
            .into_any_element()
    }

    fn check_updates(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let checking = self.model.read(cx).updates.checking;
        menu_button(
            s,
            "check-updates",
            if checking {
                "Checking…"
            } else {
                "Check for Updates…"
            },
            None,
            Kind::Plain,
            false,
            checking || config::DEV,
        )
        .on_click(|_, _, cx| Shell::check_for_updates(cx))
        .into_any_element()
    }
}

// Pieces

fn rgb_hsla(hex: u32) -> Hsla {
    gpui::rgb(hex).into()
}

fn debug_banner() -> impl IntoElement {
    let server = config::endpoints().server;
    let host = server.split("://").nth(1).unwrap_or(&server).to_string();
    div()
        .w_full()
        .py(px(5.))
        .rounded(px(6.))
        .bg(rgb_hsla(0xff9500))
        .text_color(gpui::white())
        .text_size(px(11.))
        .font_weight(FontWeight::BOLD)
        .font_family("Consolas")
        .px(px(8.))
        .text_center()
        .whitespace_nowrap()
        .overflow_hidden()
        .text_ellipsis()
        .child(format!("DEBUG BUILD · {host}"))
}

fn brand(s: Surface, subtitle: &str, trailing: Option<AnyElement>) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .child(svg().path(MARK_PATH).size(px(26.)).text_color(s.primary))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(1.))
                .child(
                    div()
                        .font_family(BRICOLAGE)
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(16.))
                        .line_height(px(20.))
                        .child("Shouldertap"),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(s.secondary)
                        .truncate()
                        .child(subtitle.to_string()),
                ),
        )
        .children(trailing)
}

fn status_label(s: Surface, status: LiveStatus) -> AnyElement {
    let (label, color) = match status {
        LiveStatus::Live => ("Connected", theme::live_green().into()),
        LiveStatus::Connecting => ("Connecting…", s.warning),
        LiveStatus::Offline => ("Offline", s.tertiary),
    };
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .child(dot(color))
        .child(div().text_size(px(12.)).text_color(s.secondary).child(label))
        .into_any_element()
}

fn dot(color: Hsla) -> impl IntoElement {
    div().size(px(7.)).rounded_full().bg(color)
}

fn section(s: Surface, title: &str, children: Vec<AnyElement>) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(s.secondary)
                .child(title.to_string()),
        )
        .child(div().flex().flex_col().gap(px(8.)).children(children))
}

pub(crate) fn muted(s: Surface, text: &str) -> gpui::Div {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(s.secondary)
        .child(text.to_string())
}

fn muted_center(s: Surface, text: &str) -> gpui::Div {
    muted(s, text).text_center()
}

pub(crate) fn error_text(s: Surface, text: String) -> impl IntoElement {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(s.danger)
        .child(text)
}

fn mono(s: Surface, text: &str) -> impl IntoElement {
    div()
        .w_full()
        .font_family("Consolas")
        .text_size(px(11.))
        .line_height(px(14.))
        .text_color(s.secondary)
        .text_center()
        .line_clamp(3)
        .child(text.to_string())
}

/// A pane: a title, its list scrolling under it, and an optional foot.
fn pane(
    id: &'static str,
    title: &str,
    trailing: Option<AnyElement>,
    rows: Vec<AnyElement>,
    foot: Option<AnyElement>,
) -> impl IntoElement {
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .h(px(26.))
                .mt(px(10.))
                .px(px(14.))
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title.to_string()),
                )
                .children(trailing),
        )
        .child(
            div().id(id).flex_1().min_h_0().overflow_y_scroll().child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .px(px(14.))
                    .py(px(6.))
                    .children(rows),
            ),
        )
        .children(foot.map(|foot| div().flex_none().px(px(14.)).pb(px(8.)).child(foot)))
}

fn hairline(s: Surface) -> impl IntoElement {
    div().h(px(1.)).w_full().flex_none().bg(s.separator)
}

/// A person: a circle in their color with their initial in its ink.
fn avatar(name: &str, color: shouldertap_core::PersonColor, size: f32) -> impl IntoElement {
    let initial = name
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_else(|| "?".into());
    div()
        .size(px(size))
        .flex_none()
        .rounded_full()
        .bg(theme::base(color))
        .flex()
        .items_center()
        .justify_center()
        .font_family(BRICOLAGE)
        .font_weight(FontWeight::BOLD)
        .text_size(px(size * 0.46))
        .text_color(theme::ink(color))
        .child(initial)
}

fn glyph(s: Surface, icon: Icon) -> impl IntoElement {
    div()
        .size(px(26.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .child(svg().path(icon.path()).size(px(18.)).text_color(s.secondary))
}

fn platform_icon(platform: DevicePlatform) -> Icon {
    match platform {
        DevicePlatform::Mac => Icon::Mac,
        DevicePlatform::Windows => Icon::Pc,
        DevicePlatform::Iphone => Icon::Phone,
    }
}

fn pairing_status(credential: &Credential, is_self: bool) -> String {
    if is_self {
        return "This PC".into();
    }
    let seen = credential
        .last_seen_at
        .map(|seen| format!("Active {}", theme::ago(seen, now_ms())))
        .unwrap_or_else(|| "Paired".into());
    if credential.kind == CredentialKind::Sender {
        return seen;
    }
    format!("{} · {seen}", credential.device_platform().label())
}

/// A list row that highlights under the pointer.
fn row(s: Surface, id: impl Into<SharedString>) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id.into())
        .flex()
        .items_center()
        .gap(px(10.))
        .p(px(6.))
        .mx(px(-6.))
        .rounded(px(7.))
        .hover(|style| style.bg(s.hover))
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Primary,
    Secondary,
    Danger,
    Plain,
}

pub(crate) fn menu_button(
    s: Surface,
    id: &'static str,
    title: &str,
    icon: Option<Icon>,
    kind: Kind,
    full_width: bool,
    disabled: bool,
) -> gpui::Stateful<gpui::Div> {
    let foreground = match kind {
        Kind::Primary => s.on_ink,
        Kind::Danger => s.danger,
        Kind::Plain => s.secondary,
        Kind::Secondary => s.primary,
    };
    let button = div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .px(px(if kind == Kind::Plain { 4. } else { 12. }))
        .min_h(px(if kind == Kind::Plain { 24. } else { 32. }))
        .rounded(px(8.))
        .text_color(foreground)
        .font_weight(if kind == Kind::Primary {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::MEDIUM
        })
        .when(full_width, |button| button.w_full())
        .when(kind == Kind::Primary, |button| button.bg(s.ink))
        .when(matches!(kind, Kind::Secondary | Kind::Danger), |button| {
            button.bg(s.card).border_1().border_color(s.separator)
        })
        .children(icon.map(|icon| svg().path(icon.path()).size(px(16.)).text_color(foreground)))
        .child(title.to_string());
    if disabled {
        button.opacity(0.45)
    } else {
        button
            .cursor_pointer()
            .when(kind == Kind::Plain, |button| {
                button.hover(|style| style.text_color(s.primary))
            })
            .when(kind != Kind::Plain, |button| button.hover(|style| style.opacity(0.88)))
            .active(|style| style.opacity(0.7))
    }
}

/// The "Open at login" switch.
fn toggle(s: Surface, id: &'static str, on: bool) -> gpui::Stateful<gpui::Div> {
    let track = if on { rgb_hsla(0x2b66d9) } else { s.separator };
    div()
        .id(id)
        .w(px(28.))
        .h(px(16.))
        .flex_none()
        .rounded_full()
        .bg(track)
        .cursor_pointer()
        .flex()
        .items_center()
        .px(px(2.))
        .when(on, |track| track.justify_end())
        .child(div().size(px(12.)).rounded_full().bg(gpui::white()))
}
