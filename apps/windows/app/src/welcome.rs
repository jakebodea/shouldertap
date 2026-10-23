//! The welcome: account-first onboarding (docs/onboarding.md, "The flow"),
//! like apps/macos's Welcome.swift, step for step. Welcome → email → six-digit
//! code → you (name and color, only when the account has none) → patron
//! themes (only while checkout is open) → ready.
//! Instead of an email, a signed-in iPhone can scan this PC's QR code ("Sign
//! in with your phone"). A Frame (docs/design.md): Cobalt, then the color you
//! pick, around a paper page, with the wordmark on the frame's top edge.
//! Windows asks for nothing else.

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla, Render, SharedString, Subscription,
    Task, Window, div, prelude::*, px, svg,
};
use shouldertap_core::{
    AccountStore, ApiError, CODE_LENGTH, DeviceCode, DeviceSignInPoll, MAX_NAME_LENGTH, PersonColor,
};

use crate::assets::{Icon, MARK_PATH};
use crate::patron;
use crate::qr::qr_code;
use crate::send::{danger_text, input, labeled, page_heading, pill, preview_frame, tone_text};
use crate::shell::{Model, Shell};
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme::{self, BRICOLAGE, paper};

/// Where the welcome opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WelcomeStep {
    Welcome,
    Email,
    Code,
    /// "Sign in with your phone": a QR code a signed-in iPhone approves.
    Phone,
    You,
    /// After the You step, while patron checkout is open: a gentle offer of
    /// patron themes, skippable.
    Patron,
    /// Set up: where Shouldertap lives, then the menu.
    Ready,
}

const WELCOME_COLOR: PersonColor = PersonColor::Cobalt;

/// Why the phone's QR code stopped working.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PhoneEnded {
    Denied,
    Expired,
}

pub struct WelcomeView {
    model: Entity<Model>,
    step: WelcomeStep,
    email: Entity<TextField>,
    code: Entity<TextField>,
    name: Entity<TextField>,
    color: PersonColor,
    busy: bool,
    error: Option<String>,
    notice: Option<String>,
    /// The You step was filled in from the account once.
    prefilled: bool,
    /// The Phone step's code, and why it stopped working.
    device: Option<DeviceCode>,
    device_ended: Option<PhoneEnded>,
    /// Polls while the Phone step shows; dropped when it leaves.
    device_poll: Option<Task<()>>,
    /// The Patron step's preview: when its cycle started, and its redraws.
    cycle_started: Instant,
    cycle: Option<Task<()>>,
    /// The preview's reply field, never shown.
    preview_reply: Entity<TextField>,
    focus: FocusHandle,
    pending_focus: bool,
    _subscriptions: Vec<Subscription>,
}

impl WelcomeView {
    pub fn new(model: Entity<Model>, step: WelcomeStep, cx: &mut Context<Self>) -> Self {
        let field = |cx: &mut Context<Self>, placeholder: &str, limit: usize| {
            let placeholder = placeholder.to_string();
            cx.new(move |cx| TextField::new(cx, placeholder, limit).colors(paper::tone(), paper::ink()))
        };
        let email = field(cx, "you@example.com", 254);
        // Room for a pasted "123 456"; only digits stay.
        let code = field(cx, "123456", 16);
        let name = field(cx, "e.g. Sam", MAX_NAME_LENGTH);
        let preview_reply = field(cx, "", 0);
        let subscriptions = vec![
            cx.observe(&model, |this, _, cx| {
                this.prefill(cx);
                cx.notify();
            }),
            cx.subscribe(&email, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.send_code(false, cx),
                TextFieldEvent::Changed => {
                    this.error = None;
                    cx.notify()
                }
                TextFieldEvent::Cancel => later(cx),
            }),
            cx.subscribe(&code, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.verify(cx),
                TextFieldEvent::Changed => this.code_changed(cx),
                TextFieldEvent::Cancel => later(cx),
            }),
            cx.subscribe(&name, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.save_profile(cx),
                TextFieldEvent::Changed => cx.notify(),
                TextFieldEvent::Cancel => later(cx),
            }),
        ];
        let mut view = Self {
            model,
            step,
            email,
            code,
            name,
            color: WELCOME_COLOR,
            busy: false,
            error: None,
            notice: None,
            prefilled: false,
            device: None,
            device_ended: None,
            device_poll: None,
            cycle_started: Instant::now(),
            cycle: None,
            preview_reply,
            focus: cx.focus_handle(),
            pending_focus: false,
            _subscriptions: subscriptions,
        };
        view.go(step, cx);
        view
    }

    fn account(&self, cx: &App) -> AccountStore {
        self.model.read(cx).account.clone()
    }

    pub fn go(&mut self, step: WelcomeStep, cx: &mut Context<Self>) {
        self.step = step;
        self.error = None;
        self.notice = None;
        self.pending_focus = true;
        // Leaving the Phone step stops polling; arriving makes a new code.
        self.device = None;
        self.device_ended = None;
        self.device_poll = None;
        if step == WelcomeStep::Phone {
            self.start_phone(cx);
        }
        // The patron preview cycles only while it shows, and never with
        // reduced motion.
        self.cycle_started = Instant::now();
        self.cycle = (step == WelcomeStep::Patron && !patron::reduces_motion(self.model.read(cx)))
            .then(|| patron::cycle_ticks(cx));
        self.prefill(cx);
        // Ready is framed in the color they picked, or the one the account had.
        if matches!(step, WelcomeStep::Patron | WelcomeStep::Ready)
            && let Some(profile) = self.model.read(cx).account_state.profile()
        {
            self.color = profile.color;
        }
        cx.notify();
    }

    /// The You step starts from what the account knows: a name an inbox had,
    /// or the profile being changed.
    fn prefill(&mut self, cx: &mut Context<Self>) {
        if self.step != WelcomeStep::You || self.prefilled {
            return;
        }
        let Some(me) = self.model.read(cx).account_state.me.clone() else {
            return;
        };
        self.prefilled = true;
        let name = me
            .profile
            .as_ref()
            .map(|profile| profile.name.clone())
            .or(me.suggested_name);
        if let Some(name) = name
            && self.name.read(cx).text().is_empty()
        {
            self.name.update(cx, |field, cx| field.set_text(&name, cx));
        }
        if let Some(profile) = me.profile {
            self.color = profile.color;
        }
    }

    /// Runs a blocking account command off the UI thread, then `done` on it.
    fn run<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(AccountStore) -> Result<T, ApiError> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, ApiError>, &mut Context<Self>) + 'static,
    ) {
        self.busy = true;
        self.error = None;
        self.notice = None;
        let account = self.account(cx);
        let task = cx.background_executor().spawn(async move { work(account) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                done(this, result, cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    // Email

    fn send_code(&mut self, again: bool, cx: &mut Context<Self>) {
        let email = self.email.read(cx).text().trim().to_string();
        if email.is_empty() || self.busy {
            return;
        }
        self.run(
            cx,
            move |account| account.send_code(&email),
            move |this, result, cx| match result {
                Ok(()) if again => this.notice = Some("Sent a new code.".into()),
                Ok(()) => {
                    this.code.update(cx, |field, cx| field.clear(cx));
                    this.go(WelcomeStep::Code, cx);
                }
                Err(error) => this.error = Some(error.to_string()),
            },
        );
    }

    // Code

    /// Digits only; six of them sign in on their own.
    fn code_changed(&mut self, cx: &mut Context<Self>) {
        let text = self.code.read(cx).text().to_string();
        let digits: String = text.chars().filter(char::is_ascii_digit).take(CODE_LENGTH).collect();
        if digits != text {
            // Sets off another change, with only the digits.
            self.code.update(cx, |field, cx| field.set_text(&digits, cx));
            return;
        }
        self.error = None;
        if digits.len() == CODE_LENGTH {
            self.verify(cx);
        }
        cx.notify();
    }

    fn verify(&mut self, cx: &mut Context<Self>) {
        let email = self.email.read(cx).text().trim().to_string();
        let code = self.code.read(cx).text().to_string();
        if code.len() != CODE_LENGTH || self.busy {
            return;
        }
        self.run(
            cx,
            move |account| account.verify(&email, &code),
            |this, result, cx| match result {
                Ok(()) => this.signed_in(cx),
                Err(error) => {
                    this.error = Some(error.to_string());
                    this.code.update(cx, |field, cx| field.clear(cx));
                }
            },
        );
    }

    /// However this PC signed in: the You step, or done when the account
    /// already has a profile.
    fn signed_in(&mut self, cx: &mut Context<Self>) {
        if self.account(cx).state().needs_profile() {
            self.go(WelcomeStep::You, cx);
        } else {
            // Back on a new PC: sync already brought everything.
            self.go(WelcomeStep::Ready, cx);
        }
    }

    // Phone

    /// A new code for a signed-in iPhone to scan, then waits for it.
    fn start_phone(&mut self, cx: &mut Context<Self>) {
        self.device = None;
        self.device_ended = None;
        self.device_poll = None;
        self.run(
            cx,
            |account| account.start_device_sign_in(),
            |this, result, cx| {
                // Left the step while the code was being made.
                if this.step != WelcomeStep::Phone {
                    return;
                }
                match result {
                    Ok(code) => {
                        this.watch_phone(code.clone(), cx);
                        this.device = Some(code);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
            },
        );
    }

    /// Polls every `interval` the server asks for until the phone answers or
    /// the code runs out.
    fn watch_phone(&mut self, code: DeviceCode, cx: &mut Context<Self>) {
        let account = self.account(cx);
        self.device_poll = Some(cx.spawn(async move |this, cx| {
            let mut interval = Duration::from_secs(code.interval.max(1));
            loop {
                cx.background_executor().timer(interval).await;
                let (account, code) = (account.clone(), code.clone());
                let result = cx
                    .background_executor()
                    .spawn(async move { account.poll_device_sign_in(&code, interval) })
                    .await;
                match this.update(cx, |this, cx| this.phone_polled(result, cx)) {
                    Ok(Some(next)) => interval = next,
                    _ => break,
                }
            }
        }));
    }

    /// When to ask again, if at all.
    fn phone_polled(&mut self, result: Result<DeviceSignInPoll, ApiError>, cx: &mut Context<Self>) -> Option<Duration> {
        let next = match result {
            Ok(DeviceSignInPoll::Pending { interval }) => Some(interval),
            Ok(DeviceSignInPoll::SignedIn(_)) => {
                self.signed_in(cx);
                None
            }
            Ok(DeviceSignInPoll::Denied) => {
                self.device_ended = Some(PhoneEnded::Denied);
                None
            }
            Ok(DeviceSignInPoll::Expired) => {
                self.device_ended = Some(PhoneEnded::Expired);
                None
            }
            // Offline for a moment: keep waiting.
            Err(error) if error.is_retryable() => Some(Duration::from_secs(5)),
            Err(error) => {
                self.error = Some(error.to_string());
                None
            }
        };
        cx.notify();
        next
    }

    // You

    fn save_profile(&mut self, cx: &mut Context<Self>) {
        let name = self.name.read(cx).text().trim().to_string();
        if name.is_empty() || self.busy {
            return;
        }
        let color = self.color;
        let patrons = self.model.read(cx).patron.clone();
        self.run(
            cx,
            move |account| {
                account.set_profile(&name, color)?;
                // Whether to offer patron themes next; trouble just skips it.
                let _ = patrons.refresh();
                Ok(())
            },
            |this, result, cx| match result {
                Ok(()) if this.model.read(cx).patron.state().checkout_enabled => this.go(WelcomeStep::Patron, cx),
                Ok(()) => this.go(WelcomeStep::Ready, cx),
                Err(error) => this.error = Some(error.to_string()),
            },
        );
    }

    // Patron

    /// Checkout in the browser, then on to Ready; an error stays here.
    fn become_patron(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let patrons = self.model.read(cx).patron.clone();
        let task = cx.background_executor().spawn(async move { patrons.checkout() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(url) => {
                        cx.open_url(&url);
                        this.go(WelcomeStep::Ready, cx);
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

/// Done: the welcome closes and the menu opens on your people.
fn finish(cx: &mut App) {
    cx.defer(|cx| {
        Shell::close_welcome(cx);
        Shell::open_menu(cx);
    });
}

/// Later: the welcome closes; the menu's Get started brings it back.
fn later(cx: &mut App) {
    cx.defer(Shell::close_welcome);
}

impl Focusable for WelcomeView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for WelcomeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.pending_focus) {
            let field = match self.step {
                WelcomeStep::Welcome | WelcomeStep::Phone => None,
                WelcomeStep::Email => Some(&self.email),
                WelcomeStep::Code => Some(&self.code),
                WelcomeStep::You => Some(&self.name),
                WelcomeStep::Patron | WelcomeStep::Ready => None,
            };
            match field {
                Some(field) => window.focus(&field.focus_handle(cx)),
                None => window.focus(&self.focus),
            }
        }
        let frame = if matches!(self.step, WelcomeStep::You | WelcomeStep::Patron | WelcomeStep::Ready) {
            self.color
        } else {
            WELCOME_COLOR
        };
        let page = match self.step {
            WelcomeStep::Welcome => self.welcome_page(frame, cx),
            WelcomeStep::Email => self.email_page(frame, cx),
            WelcomeStep::Code => self.code_page(cx),
            WelcomeStep::Phone => self.phone_page(frame, cx),
            WelcomeStep::You => self.you_page(cx),
            WelcomeStep::Patron => self.patron_page(window, cx),
            WelcomeStep::Ready => self.ready_page(cx),
        };
        div()
            .id("welcome")
            .track_focus(&self.focus)
            // Esc is Later, like the Mac's; set up, there's nothing to skip.
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && !matches!(this.step, WelcomeStep::Patron | WelcomeStep::Ready) {
                    later(cx);
                }
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(theme::base(frame))
            .text_color(paper::ink())
            .font_family(BRICOLAGE)
            .text_size(px(15.))
            .child(self.band(frame, cx))
            .child(
                div().flex_1().min_h_0().px(px(10.)).pb(px(10.)).child(
                    div()
                        .id("page")
                        .size_full()
                        .rounded(px(22.))
                        .bg(paper::paper())
                        .overflow_y_scroll()
                        .child(div().flex().flex_col().gap(px(20.)).p(px(28.)).children(page)),
                ),
            )
    }
}

// Pages

impl WelcomeView {
    /// The wordmark on the frame's top edge, Back while signing in, and Later
    /// until you're set up.
    fn band(&mut self, frame: PersonColor, cx: &mut Context<Self>) -> impl IntoElement {
        let ink: Hsla = theme::ink(frame).into();
        let back = match self.step {
            WelcomeStep::Email => Some(WelcomeStep::Welcome),
            WelcomeStep::Code | WelcomeStep::Phone => Some(WelcomeStep::Email),
            _ => None,
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .h(px(60.))
            .px(px(18.))
            .text_color(ink)
            .child(svg().path(MARK_PATH).size(px(22.)).text_color(ink))
            .child(
                div()
                    .font_weight(FontWeight::EXTRA_BOLD)
                    .text_size(px(16.))
                    .child("Shouldertap"),
            )
            .child(div().flex_1())
            .when(
                matches!(
                    self.step,
                    WelcomeStep::Email | WelcomeStep::Code | WelcomeStep::Phone | WelcomeStep::You
                ),
                |band| {
                    band.child(
                        div()
                            .id("later")
                            .px(px(8.))
                            .cursor_pointer()
                            .font_weight(FontWeight::BOLD)
                            .text_size(px(13.))
                            .hover(|style| style.opacity(0.8))
                            .on_click(|_, _, cx| later(cx))
                            .child("Later"),
                    )
                },
            )
            .when_some(back.filter(|_| !self.busy), |band, step| {
                band.child(
                    div()
                        .id("back")
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .h(px(32.))
                        .px(px(12.))
                        .rounded_full()
                        .border_2()
                        .border_color(ink.opacity(0.35))
                        .cursor_pointer()
                        .hover(|style| style.border_color(ink))
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(13.))
                        .on_click(cx.listener(move |this, _, _, cx| this.go(step, cx)))
                        .child(svg().path(Icon::Back.path()).size(px(15.)).text_color(ink))
                        .child("Back"),
                )
            })
    }

    fn welcome_page(&mut self, frame: PersonColor, cx: &mut Context<Self>) -> Vec<AnyElement> {
        vec![
            div()
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_size(px(44.))
                .line_height(px(44.))
                .child("Welcome to Shouldertap.")
                .into_any_element(),
            tone_text(
                "When someone you trust taps you on the shoulder, their message covers your screen, just like this, until you answer.",
            )
            .text_size(px(16.))
            .into_any_element(),
            preview_frame("Sam", PersonColor::Plum).into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    pill("get-started", "Get started", None, Some(frame), false)
                        .w_full()
                        .on_click(cx.listener(|this, _, _, cx| this.go(WelcomeStep::Email, cx))),
                )
                .child(
                    pill("later", "Later", None, None, false)
                        .w_full()
                        .on_click(|_, _, cx| later(cx)),
                )
                .child(
                    div()
                        .id("have-account")
                        .pt(px(4.))
                        .text_color(paper::tone())
                        .underline()
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| this.go(WelcomeStep::Email, cx)))
                        .child("I have an account"),
                )
                .into_any_element(),
        ]
    }

    fn email_page(&mut self, frame: PersonColor, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let ready = !self.email.read(cx).text().trim().is_empty() && !self.busy;
        let mut page = vec![
            page_heading(
                "What's your email?",
                "We'll send you a code to sign in. No password to remember.",
            ),
            labeled("Email", input(&self.email, cx)),
        ];
        page.extend(self.messages());
        page.push(
            pill(
                "send-code",
                if self.busy { "Sending…" } else { "Send code" },
                None,
                Some(frame),
                !ready,
            )
            .w_full()
            .when(ready, |pill| {
                pill.on_click(cx.listener(|this, _, _, cx| this.send_code(false, cx)))
            })
            .into_any_element(),
        );
        page.push(
            pill(
                "with-phone",
                "Sign in with your phone",
                Some(Icon::Phone),
                None,
                self.busy,
            )
            .w_full()
            .when(!self.busy, |pill| {
                pill.on_click(cx.listener(|this, _, _, cx| this.go(WelcomeStep::Phone, cx)))
            })
            .into_any_element(),
        );
        page
    }

    /// A QR code for a signed-in iPhone to scan, with the code to check
    /// under it, until the phone approves.
    fn phone_page(&mut self, frame: PersonColor, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut page = vec![page_heading(
            "Sign in with your phone.",
            "Open Shouldertap on your iPhone → Account → Sign in on a computer, and scan this.",
        )];
        let side = px(220.);
        let ended = self.device_ended;
        match (&self.device, ended) {
            (Some(code), None) => page.push(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(14.))
                    .child(qr_code(&code.verification_uri_complete, side))
                    .child(
                        div()
                            .font_family("Consolas")
                            .font_weight(FontWeight::BOLD)
                            .text_size(px(32.))
                            .line_height(px(36.))
                            .child(code.user_code.clone()),
                    )
                    .child(tone_text("Waiting for your iPhone…"))
                    .into_any_element(),
            ),
            (_, Some(ended)) => page.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(danger_text(
                        match ended {
                            PhoneEnded::Denied => "Your phone declined this sign-in.",
                            PhoneEnded::Expired => "That code expired.",
                        }
                        .into(),
                    ))
                    .child(
                        pill("phone-new-code", "Show a new code", None, Some(frame), self.busy)
                            .w_full()
                            .when(!self.busy, |pill| {
                                pill.on_click(cx.listener(|this, _, _, cx| this.start_phone(cx)))
                            }),
                    )
                    .into_any_element(),
            ),
            (None, None) if self.busy => page.push(
                div()
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .size(side)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(tone_text("Making a code…")),
                    )
                    .into_any_element(),
            ),
            // Couldn't make one: the error says why.
            (None, None) => page.push(
                pill("phone-try-again", "Try again", None, Some(frame), false)
                    .w_full()
                    .on_click(cx.listener(|this, _, _, cx| this.start_phone(cx)))
                    .into_any_element(),
            ),
        }
        page.extend(self.messages());
        page.push(
            pill("with-email", "Use your email instead", None, None, self.busy)
                .w_full()
                .when(!self.busy, |pill| {
                    pill.on_click(cx.listener(|this, _, _, cx| this.go(WelcomeStep::Email, cx)))
                })
                .into_any_element(),
        );
        page
    }

    fn code_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let email = self.email.read(cx).text().trim().to_string();
        let mut page = vec![
            page_heading(
                "Check your email.",
                &format!("Enter the six digits we sent to {email}."),
            ),
            labeled("Code", input(&self.code, cx)),
        ];
        page.extend(self.messages());
        if self.busy {
            page.push(tone_text("Checking…").into_any_element());
        }
        let busy = self.busy;
        page.push(
            div()
                .flex()
                .gap(px(8.))
                .child(pill("resend", "Resend", None, None, busy).when(!busy, |pill| {
                    pill.on_click(cx.listener(|this, _, _, cx| this.send_code(true, cx)))
                }))
                .child(
                    pill("change-email", "Change email", None, None, busy).when(!busy, |pill| {
                        pill.on_click(cx.listener(|this, _, _, cx| this.go(WelcomeStep::Email, cx)))
                    }),
                )
                .into_any_element(),
        );
        page
    }

    fn you_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let name = self.name.read(cx).text().trim().to_string();
        let ready = !name.is_empty() && !self.busy;
        let mut page = vec![
            page_heading(
                "What should people call you?",
                "Your name and color frame every tap you send, so they know it's you from across the room.",
            ),
            labeled("Your name", input(&self.name, cx)),
            labeled("Your color", self.swatches(cx)),
            preview_frame(if name.is_empty() { "You" } else { &name }, self.color).into_any_element(),
        ];
        page.extend(self.messages());
        page.push(
            pill(
                "continue",
                if self.busy { "Saving…" } else { "Continue" },
                None,
                Some(self.color),
                !ready,
            )
            .w_full()
            .when(ready, |pill| {
                pill.on_click(cx.listener(|this, _, _, cx| this.save_profile(cx)))
            })
            .into_any_element(),
        );
        page
    }

    /// Help keep Shouldertap free: their own tap, cycling through the patron
    /// themes, and a choice that's easy to put off.
    fn patron_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let name = self
            .model
            .read(cx)
            .account_state
            .profile()
            .map(|profile| profile.name.clone())
            .unwrap_or_else(|| self.name.read(cx).text().trim().to_string());
        let name = if name.is_empty() { "You".to_string() } else { name };
        let reduce = patron::reduces_motion(self.model.read(cx));
        let (shown, elapsed) = patron::cycle_at(self.cycle_started, reduce);
        // The page's width inside the frame and its padding.
        let width = (f32::from(window.viewport_size().width) - 20. - 56.).max(200.);
        let preview = patron::preview(
            shown,
            patron::sample(&name, self.color, patron::SAMPLE),
            width,
            width * 900. / 1440.,
            elapsed,
            reduce,
            &self.preview_reply,
            12.,
            window,
            cx,
        );
        let busy = self.busy;
        let mut page = vec![
            div()
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_size(px(46.))
                .line_height(px(46.))
                .child("Help keep Shouldertap free.")
                .into_any_element(),
            tone_text(
                "Shouldertap is free for everyone, kept running by patrons. If you'd like to chip in, your taps can arrive as a front page, a poster, a console or a handwritten note. The people you tap never pay to see them.",
            )
            .text_size(px(16.))
            .into_any_element(),
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .child(preview)
                .child(tone_text(shown.label()).font_weight(FontWeight::BOLD))
                .into_any_element(),
        ];
        page.extend(self.messages());
        page.push(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    pill(
                        "become-patron",
                        if busy { "Opening…" } else { "Become a patron" },
                        None,
                        Some(self.color),
                        busy,
                    )
                    .w_full()
                    .when(!busy, |pill| {
                        pill.on_click(cx.listener(|this, _, _, cx| this.become_patron(cx)))
                    }),
                )
                .child(
                    pill("maybe-later", "Maybe later", None, None, busy)
                        .w_full()
                        .when(!busy, |pill| {
                            pill.on_click(cx.listener(|this, _, _, cx| this.go(WelcomeStep::Ready, cx)))
                        }),
                )
                .child(tone_text(patron::WELCOME_PRICE).text_size(px(13.)))
                .into_any_element(),
        );
        page
    }

    fn ready_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let name = self
            .model
            .read(cx)
            .account_state
            .profile()
            .map(|profile| profile.name.clone())
            .unwrap_or_else(|| self.name.read(cx).text().trim().to_string());
        vec![
            page_heading(
                &format!("You're all set, {name}."),
                "Shouldertap lives in the system tray, by the clock. Invite someone from it; when they tap, it covers this screen until you answer.",
            ),
            pill("open-menu", "Open the menu", None, Some(self.color), false)
                .w_full()
                .on_click(|_, _, cx| finish(cx))
                .into_any_element(),
        ]
    }

    fn messages(&self) -> Vec<AnyElement> {
        let mut messages = Vec::new();
        if let Some(error) = self.error.clone() {
            messages.push(danger_text(error).into_any_element());
        }
        if let Some(notice) = &self.notice {
            messages.push(tone_text(notice).into_any_element());
        }
        messages
    }

    /// The eight person colors, two rows of four.
    fn swatches(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let swatches = PersonColor::ALL.map(|option| {
            let selected = option == self.color;
            div()
                .id(SharedString::from(format!("color-{}", option.swatch().label)))
                .flex_1()
                .h(px(48.))
                .p(px(3.))
                .rounded_full()
                .border_2()
                .border_color(if selected {
                    paper::ink().into()
                } else {
                    gpui::transparent_black()
                })
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.color = option;
                    cx.notify();
                }))
                .child(
                    div()
                        .size_full()
                        .rounded_full()
                        .bg(theme::base(option))
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(selected, |swatch| {
                            swatch.child(
                                svg()
                                    .path(Icon::OnIt.path())
                                    .size(px(20.))
                                    .text_color(theme::ink(option)),
                            )
                        }),
                )
        });
        let [a, b, c, d, e, f, g, h] = swatches;
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(div().flex().gap(px(10.)).child(a).child(b).child(c).child(d))
            .child(div().flex().gap(px(10.)).child(e).child(f).child(g).child(h))
            .into_any_element()
    }
}

impl Shell {
    /// Opens the welcome on `step`, or moves the open one there.
    pub fn open_welcome(step: WelcomeStep, cx: &mut App) {
        Shell::close_menu(cx);
        if let Some(handle) = cx.global::<Shell>().welcome
            && handle
                .update(cx, |view, window, cx| {
                    view.go(step, cx);
                    window.activate_window();
                })
                .is_ok()
        {
            return;
        }
        let model = cx.global::<Shell>().model.clone();
        let bounds = gpui::Bounds::centered(None, gpui::size(px(520.), px(720.)), cx);
        let handle = cx
            .open_window(
                gpui::WindowOptions {
                    window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Welcome to Shouldertap".into()),
                        ..Default::default()
                    }),
                    focus: true,
                    show: true,
                    is_resizable: true,
                    window_min_size: Some(gpui::size(px(420.), px(560.))),
                    app_id: Some(crate::config::APP_ID.into()),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| WelcomeView::new(model, step, cx)),
            )
            .ok();
        if let Some(handle) = handle {
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
        cx.global_mut::<Shell>().welcome = handle;
    }

    pub fn close_welcome(cx: &mut App) {
        if let Some(welcome) = cx.global_mut::<Shell>().welcome.take() {
            let _ = welcome.update(cx, |_, window, _| window.remove_window());
        }
    }
}
