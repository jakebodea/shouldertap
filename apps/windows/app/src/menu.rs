//! The tray menu, ported from apps/macos's MenuView.swift: a native surface,
//! so the system font and light or dark colors, with Bricolage only in the
//! "Shouldertap" title (docs/design.md, "Surfaces").

use std::collections::HashMap;

use gpui::{
    AnyElement, App, Bounds, ClickEvent, ClipboardItem, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla,
    MouseButton, Pixels, Render, SharedString, Subscription, Window, div, prelude::*, px, svg,
};
use shouldertap_core::{
    ApiError, Credential, CredentialKind, DevicePlatform, ErrorCode, LiveStatus, MAX_NAME_LENGTH, Phase, Plan,
    PlanStatus, ReceiverStore, ResponseKind, SenderInvite, Tap, TapState, now_ms,
};

use crate::assets::{Icon, MARK_PATH};
use crate::config;
use crate::platform::{self, TrayAnchor};
use crate::qr::qr_code;
use crate::shell::{Model, Shell};
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme::{self, BRICOLAGE, Surface};

pub const MIN_HEIGHT: f32 = 120.;
/// Grow with the content, and scroll past this.
const MAX_HEIGHT: f32 = 620.;

pub struct MenuView {
    model: Entity<Model>,
    anchor: Option<TrayAnchor>,
    focus: FocusHandle,
    height: f32,
    // Setup
    name: Entity<TextField>,
    code: Entity<TextField>,
    busy: bool,
    error: Option<String>,
    // Plan
    plan_busy: bool,
    plan_opened: bool,
    plan_error: Option<String>,
    plan_notice: Option<String>,
    // Invite someone
    invite: Option<SenderInvite>,
    invite_copied: bool,
    invite_error: Option<String>,
    // Add a device
    device_code: Option<String>,
    device_copied: bool,
    device_error: Option<String>,
    // Pairings
    confirming: Option<String>,
    row_errors: HashMap<String, String>,
    _subscriptions: Vec<Subscription>,
}

impl MenuView {
    pub fn new(model: Entity<Model>, anchor: Option<TrayAnchor>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let surface = Surface::new(platform::is_dark(window));
        let name = cx.new(|cx| {
            TextField::new(cx, "Your first name, as senders will see it", MAX_NAME_LENGTH)
                .colors(surface.tertiary, surface.primary)
        });
        let code = cx.new(|cx| {
            TextField::new(cx, "Paste the pairing code from your other computer", 512)
                .colors(surface.tertiary, surface.primary)
        });
        let subscriptions = vec![
            cx.observe(&model, |_, _, cx| cx.notify()),
            cx.subscribe(&name, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.create_inbox(cx),
                TextFieldEvent::Changed => cx.notify(),
                TextFieldEvent::Cancel => Shell::close_menu(cx),
            }),
            cx.subscribe(&code, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.join(cx),
                TextFieldEvent::Changed => cx.notify(),
                TextFieldEvent::Cancel => Shell::close_menu(cx),
            }),
            // Like a flyout: clicking anywhere else closes it.
            cx.observe_window_activation(window, |_, window, cx| {
                if !window.is_window_active() {
                    Shell::menu_deactivated(cx);
                }
            }),
            cx.observe_window_appearance(window, |this, window, cx| {
                let surface = Surface::new(platform::is_dark(window));
                for field in [&this.name, &this.code] {
                    field.update(cx, |field, _| field.set_colors(surface.tertiary, surface.primary));
                }
                cx.notify();
            }),
        ];
        let focus = cx.focus_handle();
        if model.read(cx).state.phase == Phase::Setup {
            window.focus(&name.focus_handle(cx));
        } else {
            window.focus(&focus);
        }
        Self {
            model,
            anchor,
            focus,
            height: MIN_HEIGHT,
            name,
            code,
            busy: false,
            error: None,
            plan_busy: false,
            plan_opened: false,
            plan_error: None,
            plan_notice: None,
            invite: None,
            invite_copied: false,
            invite_error: None,
            device_code: None,
            device_copied: false,
            device_error: None,
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

    // Setup

    fn create_inbox(&mut self, cx: &mut Context<Self>) {
        let name = self.name.read(cx).text().trim().to_string();
        if name.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        self.run(
            cx,
            move |store| store.create_inbox(&name),
            |this, result, _| {
                this.busy = false;
                this.error = result.err().map(|error| error.to_string());
            },
        );
    }

    fn join(&mut self, cx: &mut Context<Self>) {
        let code = self.code.read(cx).text().trim().to_string();
        if code.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        self.run(
            cx,
            move |store| store.join(&code),
            |this, result, _| {
                this.busy = false;
                this.error = result.err().map(|error| error.to_string());
            },
        );
    }

    // Plan

    fn unlock(&mut self, cx: &mut Context<Self>) {
        self.plan_busy = true;
        self.plan_error = None;
        self.plan_notice = None;
        self.run(
            cx,
            |store| store.checkout_url(),
            |this, result, cx| {
                this.plan_busy = false;
                match result {
                    Ok(url) => {
                        cx.open_url(&url);
                        this.plan_opened = true;
                    }
                    // Already paid: the store refreshes the plan, so say so quietly.
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

    fn create_device_code(&mut self, cx: &mut Context<Self>) {
        self.device_error = None;
        self.run(
            cx,
            |store| store.create_device_code(),
            |this, result, _| match result {
                Ok(invite) => this.device_code = Some(invite.code),
                Err(error) => this.device_error = Some(error.to_string()),
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

    /// The window follows its content's height, anchored to the tray.
    fn content_measured(&mut self, height: f32, window: &mut Window, cx: &mut Context<Self>) {
        let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT).ceil();
        if (height - self.height).abs() < 1. {
            return;
        }
        self.height = height;
        let anchor = self.anchor;
        window.on_next_frame(move |window, _| platform::resize_menu(window, height, anchor));
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
        let phase = self.model.read(cx).state.phase;
        let body: AnyElement = match phase {
            Phase::Loading => div().h(px(120.)).into_any_element(),
            Phase::Setup => self.setup(s, window, cx).into_any_element(),
            Phase::Ready => self.ready(s, cx).into_any_element(),
        };
        let this = cx.entity();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(14.))
            .when(config::DEV, |content| content.child(debug_banner()))
            .child(body);
        div()
            .id("menu")
            .track_focus(&self.focus)
            .key_context("Menu")
            .on_key_down(cx.listener(|_, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    Shell::close_menu(cx);
                }
            }))
            .size_full()
            .bg(s.background)
            .text_color(s.primary)
            .text_size(px(13.))
            .overflow_y_scroll()
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
    }
}

// Screens

impl MenuView {
    fn setup(&mut self, s: Surface, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name_empty = self.name.read(cx).text().trim().is_empty();
        let code_empty = self.code.read(cx).text().trim().is_empty();
        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(brand(s, "Welcome", None))
            .child(muted(
                s,
                "People you trust can tap you on the shoulder. Their message covers your screens until you answer, and they see your reply right away.",
            ))
            .child(section(
                s,
                "Set up this PC",
                vec![
                    field(s, &self.name, window, cx),
                    menu_button(s, "get-started", "Get started", None, Kind::Primary, true, self.busy || name_empty)
                        .on_click(cx.listener(|this, _, _, cx| this.create_inbox(cx)))
                        .into_any_element(),
                ],
            ))
            .child(section(
                s,
                "Already set up on another computer?",
                vec![
                    field(s, &self.code, window, cx),
                    menu_button(s, "pair", "Pair this PC", Some(Icon::AddDevice), Kind::Secondary, true, self.busy || code_empty)
                        .on_click(cx.listener(|this, _, _, cx| this.join(cx)))
                        .into_any_element(),
                ],
            ))
            .when_some(self.error.clone(), |el, error| el.child(error_text(s, error)))
            .when(self.busy, |el| el.child(muted(s, "Working…")))
            .child(self.footer(s, cx))
    }

    fn ready(&mut self, s: Surface, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.model.read(cx).state.clone();
        let senders: Vec<Credential> = state
            .credentials
            .iter()
            .filter(|c| c.kind == CredentialKind::Sender)
            .cloned()
            .collect();
        let devices: Vec<Credential> = state
            .credentials
            .iter()
            .filter(|c| c.kind == CredentialKind::Device)
            .cloned()
            .collect();
        // "Taps for Jake", plus a quiet "Unlocked" once paid for.
        let subtitle = if state.recipient_name.is_empty() {
            " ".to_string()
        } else if state.plan.map(|plan| plan.status) == Some(PlanStatus::Paid) {
            format!("Taps for {} · Unlocked", state.recipient_name)
        } else {
            format!("Taps for {}", state.recipient_name)
        };

        let mut people: Vec<AnyElement> = Vec::new();
        if senders.is_empty() {
            people.push(muted(s, "No one yet. Invite someone above.").into_any_element());
        } else {
            for sender in &senders {
                people.push(self.pairing_row(s, sender, false, cx));
            }
        }
        let mut your_devices: Vec<AnyElement> = devices
            .iter()
            .map(|device| self.pairing_row(s, device, Some(&device.id) == state.credential_id.as_ref(), cx))
            .collect();
        your_devices.push(self.add_device(s, cx));
        let recent: Vec<AnyElement> = if state.taps.is_empty() {
            vec![muted(s, "Taps you receive show up here.").into_any_element()]
        } else {
            state.taps.iter().take(6).map(|tap| tap_row(s, tap)).collect()
        };

        let plan = state
            .plan
            .filter(|plan| plan.current_status(now_ms()) != PlanStatus::Paid)
            .map(|plan| {
                self.plan(
                    s,
                    plan,
                    state.taps.iter().any(|tap| tap.state == TapState::Acknowledged),
                    cx,
                )
            });

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(brand(s, &subtitle, Some(status_label(s, state.status))))
            .children(plan)
            .child(self.invite_sender(s, cx))
            .child(section(s, "Can tap you", people))
            .child(section(s, "Your devices", your_devices))
            .child(section(s, "Recent", recent))
            .child(self.footer(s, cx))
    }

    /// The trial and the way out of it. Quiet while the trial has time left,
    /// a card in its last 3 days, and the first thing in the menu once it ends.
    fn plan(&mut self, s: Surface, plan: Plan, answered: bool, cx: &mut Context<Self>) -> AnyElement {
        let now = now_ms();
        let days = plan.days_left(now);
        let label = if self.plan_busy {
            "Opening checkout…"
        } else {
            "Unlock for $5"
        };
        let messages = self.plan_messages(s);
        let unlock = |kind: Kind, cx: &mut Context<Self>| {
            menu_button(s, "unlock", label, None, kind, true, self.plan_busy)
                .on_click(cx.listener(|this, _, _, cx| this.unlock(cx)))
        };
        if plan.current_status(now) == PlanStatus::Expired {
            card(s)
                .child(
                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("Your trial ended — taps are paused"))
                        .child(muted(s, "Unlock Shouldertap for a one-time $5. People who can tap you get through again right away.")),
                )
                .child(unlock(Kind::Primary, cx))
                .children(messages)
                .into_any_element()
        } else if days <= 3 {
            let title = if days == 1 {
                "Last day of your trial".to_string()
            } else {
                format!("Trial · {days} days left")
            };
            card(s)
                .child(
                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(dot(s.warning))
                                .child(div().font_weight(FontWeight::SEMIBOLD).child(title)),
                        )
                        .child(muted(
                            s,
                            "Taps pause when the trial ends. Unlock for good with a one-time $5.",
                        )),
                )
                .child(unlock(Kind::Secondary, cx))
                .children(messages)
                .into_any_element()
        } else if answered {
            // Ask once it has worked: the first tap they answered.
            card(s)
                .child(
                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("Liking Shouldertap?"))
                        .child(muted(
                            s,
                            &format!("Keep it for good with a one-time $5. Trial · {days} days left."),
                        )),
                )
                .child(unlock(Kind::Secondary, cx))
                .children(messages)
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(12.))
                                .text_color(s.secondary)
                                .child(format!("Trial · {days} days left")),
                        )
                        .child(
                            menu_button(
                                s,
                                "unlock-plain",
                                "Unlock for $5",
                                None,
                                Kind::Plain,
                                false,
                                self.plan_busy,
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.unlock(cx))),
                        ),
                )
                .children(messages)
                .into_any_element()
        }
    }

    fn plan_messages(&self, s: Surface) -> Option<AnyElement> {
        if let Some(error) = &self.plan_error {
            Some(error_text(s, error.clone()).into_any_element())
        } else if let Some(notice) = &self.plan_notice {
            Some(muted(s, notice).into_any_element())
        } else if self.plan_opened {
            Some(
                muted(
                    s,
                    "Finish checking out in your browser. This updates on its own once you've paid.",
                )
                .into_any_element(),
            )
        } else {
            None
        }
    }

    fn invite_sender(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let Some(invite) = self.invite.clone() else {
            return div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    menu_button(
                        s,
                        "invite",
                        "Invite someone",
                        Some(Icon::Invite),
                        Kind::Primary,
                        true,
                        false,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.create_invite(cx))),
                )
                .when_some(self.invite_error.clone(), |el, error| el.child(error_text(s, error)))
                .into_any_element();
        };
        let url = invite.url.clone();
        card(s)
            .child(qr_code(&invite.url, px(176.)))
            .child(muted_center(
                s,
                "Scan with their iPhone camera, or send them the link. It works once and expires in 7 days.",
            ))
            .child(mono(s, &invite.url))
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

    /// Another computer pastes the code; an iPhone scans the QR code, which
    /// opens Shouldertap on it (`shouldertap://link#<code>`, the code in the
    /// fragment like invite links).
    fn add_device(&mut self, s: Surface, cx: &mut Context<Self>) -> AnyElement {
        let Some(code) = self.device_code.clone() else {
            return div()
                .flex()
                .flex_col()
                .child(
                    row(s, "add-device")
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| this.create_device_code(cx)))
                        .child(glyph(s, Icon::AddDevice))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(s.secondary)
                                .child("Add a Mac, PC or iPhone"),
                        ),
                )
                .when_some(self.device_error.clone(), |el, error| el.child(error_text(s, error)))
                .into_any_element();
        };
        let copy = code.clone();
        card(s)
            .mt(px(4.))
            .child(qr_code(&format!("shouldertap://link#{code}"), px(148.)))
            .child(muted_center(
                s,
                "Scan with your iPhone's camera to link it, or paste the code into Shouldertap on another Mac or PC. It works once and expires in 15 minutes.",
            ))
            .child(mono(s, &code))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        menu_button(
                            s,
                            "copy-code",
                            if self.device_copied { "Copied" } else { "Copy code" },
                            Some(Icon::Copy),
                            Kind::Primary,
                            false,
                            false,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                            this.device_copied = true;
                            cx.notify();
                        })),
                    )
                    .child(menu_button(s, "code-done", "Done", None, Kind::Plain, false, false).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.device_code = None;
                            this.device_copied = false;
                            cx.notify();
                        },
                    ))),
            )
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
            avatar(&credential.name, credential.swatch_color()).into_any_element()
        } else {
            glyph(s, platform_icon(credential.device_platform())).into_any_element()
        };
        let group: SharedString = format!("row-{id}").into();
        let trailing = if self.confirming.as_deref() == Some(id.as_str()) {
            let confirm_id = id.clone();
            div()
                .flex()
                .gap(px(8.))
                .child(
                    menu_button(
                        s,
                        "confirm-remove",
                        if is_self { "Unpair" } else { "Remove" },
                        None,
                        Kind::Danger,
                        false,
                        false,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.revoke(confirm_id.clone(), cx))),
                )
                .child(
                    menu_button(s, "cancel-remove", "Cancel", None, Kind::Plain, false, false).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.confirming = None;
                            cx.notify();
                        },
                    )),
                )
                .into_any_element()
        } else {
            let remove_id = id.clone();
            div()
                .id(SharedString::from(format!("remove-{id}")))
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .cursor_pointer()
                .invisible()
                .group_hover(group.clone(), |style| style.visible())
                .hover(|style| style.bg(s.hover))
                .text_color(s.secondary)
                .child(svg().path(Icon::Remove.path()).size(px(16.)).text_color(s.secondary))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.row_errors.remove(&remove_id);
                    this.confirming = Some(remove_id.clone());
                    cx.notify();
                }))
                .into_any_element()
        };
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

    fn footer(&mut self, s: Surface, cx: &mut Context<Self>) -> impl IntoElement {
        let (updates, launch_at_login) = {
            let model = self.model.read(cx);
            (model.updates.clone(), model.launch_at_login)
        };
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
        let model = self.model.clone();
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
                    .child(toggle(s, "launch-at-login", launch_at_login).on_click(move |_, _, cx| {
                        let enabled = !model.read(cx).launch_at_login;
                        let _ = platform::set_launch_at_login(enabled);
                        model.update(cx, |model, cx| {
                            model.launch_at_login = platform::launch_at_login();
                            cx.notify();
                        });
                    }))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(12.))
                            .text_color(s.secondary)
                            .child("Open at login"),
                    )
                    .child(
                        menu_button(
                            s,
                            "check-updates",
                            if updates.checking {
                                "Checking…"
                            } else {
                                "Check for Updates…"
                            },
                            None,
                            Kind::Plain,
                            false,
                            updates.checking || config::DEV,
                        )
                        .on_click(|_, _, cx| Shell::check_for_updates(cx)),
                    )
                    .child(
                        menu_button(s, "quit", "Quit", None, Kind::Plain, false, false).on_click(|_, _, cx| cx.quit()),
                    ),
            )
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

fn muted(s: Surface, text: &str) -> gpui::Div {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(s.secondary)
        .child(text.to_string())
}

fn muted_center(s: Surface, text: &str) -> gpui::Div {
    muted(s, text).text_center()
}

fn error_text(s: Surface, text: String) -> impl IntoElement {
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

fn card(s: Surface) -> gpui::Div {
    div()
        .w_full()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(10.))
        .p(px(12.))
        .rounded(px(10.))
        .bg(s.card)
        .border_1()
        .border_color(s.separator)
}

fn field(s: Surface, field: &Entity<TextField>, window: &Window, cx: &App) -> AnyElement {
    let focused_border = if s.dark { rgb_hsla(0x6aa0ff) } else { rgb_hsla(0x2b66d9) };
    let handle = field.focus_handle(cx);
    let focused = handle.clone();
    div()
        .w_full()
        .h(px(30.))
        .px(px(9.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .bg(s.card)
        .border_1()
        .border_color(s.separator)
        .text_size(px(13.))
        .line_height(px(18.))
        .on_mouse_down(MouseButton::Left, move |_, window, _| window.focus(&focused))
        .when(handle.is_focused(window), |el| el.border_color(focused_border))
        .child(field.clone())
        .into_any_element()
}

/// A person: a circle in their color with their initial in its ink.
fn avatar(name: &str, color: shouldertap_core::PersonColor) -> impl IntoElement {
    let initial = name
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_else(|| "?".into());
    div()
        .size(px(26.))
        .flex_none()
        .rounded_full()
        .bg(theme::base(color))
        .flex()
        .items_center()
        .justify_center()
        .font_family(BRICOLAGE)
        .font_weight(FontWeight::BOLD)
        .text_size(px(12.))
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

fn tap_row(s: Surface, tap: &Tap) -> AnyElement {
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
    row(s, SharedString::from(format!("tap-{}", tap.id)))
        .items_start()
        .child(avatar(&tap.sender_name, tap.sender_color))
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
                        .text_color(s.secondary)
                        .children(icon.map(|icon| svg().path(icon.path()).size(px(13.)).text_color(s.secondary)))
                        .child(
                            div()
                                .truncate()
                                .child(format!("{label} · {}", theme::ago(tap.created_at, now_ms()))),
                        ),
                ),
        )
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Primary,
    Secondary,
    Danger,
    Plain,
}

fn menu_button(
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
