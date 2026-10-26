//! The Send window: tap the people this PC can tap, like apps/ios's
//! ComposeView (apps/web's tap.tsx). The sender's color frames it
//! (docs/design.md, "Sender (Mac and Windows)"): people as chips on the
//! frame's top edge with Add someone beside them, and the composer or
//! accepting an invite (docs/onboarding.md) on the paper page. Under Send
//! tap, the style taps go in: patron themes (docs/design.md, "Tap themes"),
//! chosen in the Tap style sheet.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla, MouseButton, Render, SharedString,
    Subscription, Task, Window, div, prelude::*, px, svg,
};
use shouldertap_core::{
    AccountStore, ApiError, InvitePreview, LiveStatus, MAX_NAME_LENGTH, MAX_TAP_LENGTH, OutgoingTap, PatronStore,
    PersonColor, Profile, ResponseKind, SenderSession, SenderState, SenderStore, Tap, TapState, TapTheme, Timestamp,
    invite_code, now_ms, token_inbox_id,
};

use crate::assets::{Icon, MARK_PATH};
use crate::patron;
use crate::shell::{Model, Shell};
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme::{self, BRICOLAGE, paper};
use crate::welcome::WelcomeStep;

/// What the window opens on.
#[derive(Clone, Debug, PartialEq)]
pub enum SendTarget {
    Person(String),
    Add,
    /// The Tap style sheet, over whoever's composer shows.
    Style,
}

#[derive(Clone, Debug, PartialEq)]
enum Confirm {
    Remove,
    DeleteData,
    Tap(String),
}

/// Where "How they see you" is open: for the invite being accepted, or for
/// someone this PC taps (docs/onboarding.md, "Change how one person sees you").
#[derive(Clone, Debug, PartialEq)]
enum SeenAsEdit {
    Invite,
    Person(String),
}

#[derive(Clone, Copy)]
enum Focus {
    Composer,
    Invite,
}

/// The countdown appears this close to the limit.
const COUNTDOWN_FROM: usize = 40;
/// A dismissed nudge fades this long (seconds).
const NUDGE_FADE: f32 = 0.18;
/// Thumbnails of the overlay, a 1440×900 display scaled down.
const THUMB_W: f32 = 88.;
const THUMB_H: f32 = 55.;
/// Long after any arrival: a settled theme.
const SETTLED: f32 = 10.;

pub struct SendView {
    model: Entity<Model>,
    /// Whose composer shows; the first person when unset or gone.
    selected: Option<String>,
    adding: bool,
    composer: Entity<TextField>,
    /// Unsent drafts by person, while the window is open.
    drafts: HashMap<String, String>,
    send_error: Option<String>,
    // Accepting an invite
    invite: Entity<TextField>,
    accepting: bool,
    accept_error: Option<String>,
    /// Who sent the pasted invite: its code, then the server's answer.
    preview: Option<(String, Option<InvitePreview>)>,
    /// "You and Sam are connected", once accepted.
    connected: Option<String>,
    /// Picked for just the person whose invite this is; None sends the
    /// account's latest profile.
    seen_as: Option<Profile>,
    // How they see you
    seen_edit: Option<SeenAsEdit>,
    seen_name: Entity<TextField>,
    seen_color: PersonColor,
    seen_busy: bool,
    seen_error: Option<String>,
    // Options and deleting
    confirming: Option<Confirm>,
    busy: bool,
    action_error: Option<String>,
    focus: FocusHandle,
    pending_focus: Option<Focus>,
    // Patron themes
    /// A tap went out from this window: a nudge may follow.
    sent_here: bool,
    /// When the nudge was dismissed, while it fades.
    nudge_fade: Option<Instant>,
    /// The Tap style sheet shows in place of the composer.
    style_open: bool,
    style_selected: TapTheme,
    /// When the sheet's large preview last arrived (Replay restarts it).
    style_started: Instant,
    /// When the Style row's cycle started; its redraws.
    cycle_started: Instant,
    _cycle: Option<Task<()>>,
    /// The previews' reply field, never shown.
    preview_reply: Entity<TextField>,
    patron_busy: bool,
    patron_error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl SendView {
    pub fn new(model: Entity<Model>, target: SendTarget, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = |cx: &mut Context<Self>, placeholder: &str, limit: usize| {
            let placeholder = placeholder.to_string();
            cx.new(move |cx| TextField::new(cx, placeholder, limit).colors(paper::tone(), paper::ink()))
        };
        let composer = cx.new(|cx| {
            TextField::new(cx, "", MAX_TAP_LENGTH)
                .multiline(4)
                .colors(paper::tone(), paper::ink())
        });
        let invite = field(cx, "Paste the invite link they sent you", 512);
        let seen_name = field(cx, "Your name", MAX_NAME_LENGTH);
        let preview_reply = field(cx, "", 0);
        let subscriptions = vec![
            cx.observe(&model, |_, _, cx| cx.notify()),
            // Back from the browser (a checkout, say): where the membership stands.
            cx.observe_window_activation(window, |this: &mut Self, window, cx| {
                if window.is_window_active() {
                    this.model.read(cx).refresh_patron();
                }
            }),
            cx.subscribe(&composer, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.send(cx),
                TextFieldEvent::Changed => {
                    this.send_error = None;
                    cx.notify()
                }
                TextFieldEvent::Cancel => {}
            }),
            cx.subscribe(&invite, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.accept(cx),
                TextFieldEvent::Changed => this.invite_changed(cx),
                TextFieldEvent::Cancel => this.cancel_adding(cx),
            }),
            cx.subscribe(&seen_name, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.save_seen_as(cx),
                TextFieldEvent::Changed => {
                    this.seen_error = None;
                    cx.notify()
                }
                TextFieldEvent::Cancel => this.close_seen_as(cx),
            }),
        ];
        // "3m ago" moves on while the window is open.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        let cycle = (!patron::reduces_motion(model.read(cx))).then(|| patron::cycle_ticks(cx));
        let mut view = Self {
            model,
            selected: None,
            adding: false,
            composer,
            drafts: HashMap::new(),
            send_error: None,
            invite,
            accepting: false,
            accept_error: None,
            preview: None,
            connected: None,
            seen_as: None,
            seen_edit: None,
            seen_name,
            seen_color: PersonColor::Cobalt,
            seen_busy: false,
            seen_error: None,
            confirming: None,
            busy: false,
            action_error: None,
            focus: cx.focus_handle(),
            pending_focus: None,
            sent_here: false,
            nudge_fade: None,
            style_open: false,
            style_selected: TapTheme::Default,
            style_started: Instant::now(),
            cycle_started: Instant::now(),
            _cycle: cycle,
            preview_reply,
            patron_busy: false,
            patron_error: None,
            _subscriptions: subscriptions,
        };
        view.show(target, cx);
        view
    }

    fn senders(&self, cx: &App) -> SenderStore {
        self.model.read(cx).senders.clone()
    }

    fn account(&self, cx: &App) -> AccountStore {
        self.model.read(cx).account.clone()
    }

    fn patron(&self, cx: &App) -> PatronStore {
        self.model.read(cx).patron.clone()
    }

    /// Your own color (picked once, on the account), framing the window
    /// while there's no one to tap.
    fn own_color(&self, cx: &App) -> PersonColor {
        let state = &self.model.read(cx).account_state;
        state.profile().map_or(PersonColor::Cobalt, |profile| profile.color)
    }

    pub fn show(&mut self, target: SendTarget, cx: &mut Context<Self>) {
        match target {
            SendTarget::Person(id) => self.select(id, cx),
            SendTarget::Add => self.start_adding(cx),
            SendTarget::Style => {
                if self.adding {
                    self.cancel_adding(cx);
                }
                self.open_style(cx);
            }
        }
    }

    /// The person the composer is for: None shows the pairing form.
    fn current(&self, state: &SenderState) -> Option<SenderSession> {
        if self.adding {
            return None;
        }
        self.selected
            .as_deref()
            .and_then(|id| state.session(id))
            .or(state.sessions.first())
            .cloned()
    }

    fn save_draft(&mut self, cx: &mut Context<Self>) {
        let state = self.model.read(cx).sender_state.clone();
        if let Some(session) = self.current(&state) {
            let draft = self.composer.read(cx).text().to_string();
            self.drafts.insert(session.id().to_string(), draft);
        }
    }

    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.save_draft(cx);
        let draft = self.drafts.get(&id).cloned().unwrap_or_default();
        self.composer.update(cx, |field, cx| field.set_text(&draft, cx));
        // One GET: the history is current even if a live event was missed.
        self.senders(cx).refresh(&id);
        if self.selected.as_ref() != Some(&id) {
            self.connected = None;
        }
        self.selected = Some(id);
        self.adding = false;
        self.send_error = None;
        self.confirming = None;
        self.action_error = None;
        self.pending_focus = Some(Focus::Composer);
        cx.notify();
    }

    fn start_adding(&mut self, cx: &mut Context<Self>) {
        if !self.adding {
            self.save_draft(cx);
        }
        // An invite link on the clipboard is almost certainly why they're here.
        if self.invite.read(cx).text().is_empty()
            && let Some(code) = cx
                .read_from_clipboard()
                .and_then(|item| item.text())
                .filter(|text| invite_code(text).is_some())
        {
            self.invite.update(cx, |field, cx| field.set_text(code.trim(), cx));
        }
        self.adding = true;
        self.style_open = false;
        self.accept_error = None;
        self.confirming = None;
        self.pending_focus = Some(Focus::Invite);
        self.invite_changed(cx);
        cx.notify();
    }

    fn cancel_adding(&mut self, cx: &mut Context<Self>) {
        if self.model.read(cx).sender_state.sessions.is_empty() {
            return;
        }
        self.adding = false;
        self.accept_error = None;
        let state = self.model.read(cx).sender_state.clone();
        if let Some(session) = self.current(&state) {
            let draft = self.drafts.get(session.id()).cloned().unwrap_or_default();
            self.composer.update(cx, |field, cx| field.set_text(&draft, cx));
        }
        self.pending_focus = Some(Focus::Composer);
        cx.notify();
    }

    /// Runs a blocking store command off the UI thread, then `done` back on it.
    fn run<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(SenderStore) -> Result<T, ApiError> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, ApiError>, &mut Context<Self>) + 'static,
    ) {
        let senders = self.senders(cx);
        let task = cx.background_executor().spawn(async move { work(senders) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                done(this, result, cx);
                cx.notify();
            });
        })
        .detach();
    }

    // Sending

    fn send(&mut self, cx: &mut Context<Self>) {
        let state = self.model.read(cx).sender_state.clone();
        let Some(session) = self.current(&state) else { return };
        let draft = self.composer.read(cx).text().to_string();
        if draft.trim().is_empty() {
            return;
        }
        let theme = self.model.read(cx).patron_state.sending_theme();
        match self.senders(cx).send(session.id(), &draft, theme) {
            Ok(()) => {
                self.composer.update(cx, |field, cx| field.clear(cx));
                self.drafts.remove(session.id());
                self.send_error = None;
                self.sent_here = true;
            }
            Err(error) => self.send_error = Some(error.to_string()),
        }
        cx.notify();
    }

    fn delete_tap(&mut self, id: String, tap_id: String, cx: &mut Context<Self>) {
        self.busy = true;
        self.action_error = None;
        self.run(
            cx,
            move |senders| senders.delete_tap(&id, &tap_id),
            |this, result, _| {
                this.busy = false;
                this.confirming = None;
                this.action_error = result.err().map(|error| error.to_string());
            },
        );
    }

    // Accepting an invite

    /// Looks up who sent a pasted invite, once per code.
    fn invite_changed(&mut self, cx: &mut Context<Self>) {
        self.accept_error = None;
        let code = invite_code(self.invite.read(cx).text());
        if code.as_deref() == self.preview.as_ref().map(|(code, _)| code.as_str()) {
            cx.notify();
            return;
        }
        self.preview = code.clone().map(|code| (code, None));
        // A different person: they start with the latest profile again.
        self.seen_as = None;
        if self.seen_edit == Some(SeenAsEdit::Invite) {
            self.seen_edit = None;
        }
        cx.notify();
        let Some(code) = code else { return };
        let account = self.account(cx);
        let task = cx.background_executor().spawn({
            let code = code.clone();
            async move { account.preview(&code) }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if let Some((current, preview)) = &mut this.preview
                    && *current == code
                {
                    *preview = result.ok();
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn accept(&mut self, cx: &mut Context<Self>) {
        let invite = self.invite.read(cx).text().trim().to_string();
        if invite.is_empty() || self.accepting || !self.model.read(cx).account_state.signed_in {
            return;
        }
        self.accepting = true;
        self.accept_error = None;
        let account = self.account(cx);
        let profile = self.seen_as.clone();
        let task = cx
            .background_executor()
            .spawn(async move { account.accept(&invite, profile.as_ref()) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.accepting = false;
                let accepted = match result {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        this.accept_error = Some(error.to_string());
                        cx.notify();
                        return;
                    }
                };
                let code = invite_code(this.invite.read(cx).text());
                let message = format!("You and {} are connected.", accepted.person.name);
                // Already connected: the key this PC has, or sync brings one.
                let id = accepted.sender.map(|sender| sender.grant.credential_id).or_else(|| {
                    let inbox = code.as_deref().and_then(token_inbox_id)?;
                    this.senders(cx).session_for_inbox(inbox)
                });
                this.invite.update(cx, |field, cx| field.clear(cx));
                this.preview = None;
                this.seen_as = None;
                match id {
                    Some(id) => this.select(id, cx),
                    None => this.account(cx).sync_in_background(),
                }
                this.connected = Some(message);
                cx.notify();
            });
        })
        .detach();
    }

    // How they see you

    /// How a new connection sees you unless you pick otherwise.
    fn send_default(&self, cx: &App) -> Option<Profile> {
        let me = self.model.read(cx).account_state.me.clone()?;
        me.send_profile.or(me.profile)
    }

    fn open_seen_as(&mut self, edit: SeenAsEdit, initial: Profile, cx: &mut Context<Self>) {
        self.seen_name.update(cx, |field, cx| field.set_text(&initial.name, cx));
        self.seen_color = initial.color;
        self.seen_edit = Some(edit);
        self.seen_error = None;
        self.confirming = None;
        cx.notify();
    }

    fn close_seen_as(&mut self, cx: &mut Context<Self>) {
        self.seen_edit = None;
        self.seen_error = None;
        cx.notify();
    }

    /// For the invite, keeps the pick until Accept; for someone this PC taps,
    /// saves it to the account. Stays open with the error, to try again.
    fn save_seen_as(&mut self, cx: &mut Context<Self>) {
        let name = self.seen_name.read(cx).text().trim().to_string();
        if name.is_empty() || self.seen_busy {
            return;
        }
        let profile = Profile {
            name,
            color: self.seen_color,
        };
        match self.seen_edit.clone() {
            None => {}
            Some(SeenAsEdit::Invite) => {
                self.seen_as = Some(profile);
                self.close_seen_as(cx);
            }
            Some(SeenAsEdit::Person(id)) => {
                self.seen_busy = true;
                self.seen_error = None;
                let account = self.account(cx);
                let task = cx
                    .background_executor()
                    .spawn(async move { account.update_send_profile(&id, &profile) });
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    let _ = this.update(cx, |this, cx| {
                        this.seen_busy = false;
                        match result {
                            Ok(()) => this.close_seen_as(cx),
                            Err(error) => {
                                this.seen_error = Some(error.to_string());
                                cx.notify();
                            }
                        }
                    });
                })
                .detach();
                cx.notify();
            }
        }
    }

    /// "{lead} ● {name} · Change".
    fn seen_as_row(&mut self, lead: &str, profile: Profile, edit: SeenAsEdit, cx: &mut Context<Self>) -> AnyElement {
        let initial = profile.clone();
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(13.))
            .text_color(paper::tone())
            .child(div().size(px(10.)).rounded_full().bg(theme::base(profile.color)))
            .child(format!("{lead} {}", profile.name))
            .child(
                div()
                    .id("seen-as-change")
                    .text_color(paper::ink())
                    .underline()
                    .cursor_pointer()
                    .child("Change")
                    .on_click(cx.listener(move |this, _, _, cx| this.open_seen_as(edit.clone(), initial.clone(), cx))),
            )
            .into_any_element()
    }

    /// Name, color and a preview, for one person only.
    fn seen_as_editor(&mut self, note: String, save_label: &str, cx: &mut Context<Self>) -> AnyElement {
        let name = self.seen_name.read(cx).text().trim().to_string();
        let ready = !name.is_empty() && !self.seen_busy;
        let color = self.seen_color;
        let swatches = PersonColor::ALL.map(|option| {
            let selected = option == color;
            div()
                .id(SharedString::from(format!("seen-color-{}", option.swatch().label)))
                .flex_1()
                .h(px(40.))
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
                    this.seen_color = option;
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
                                    .size(px(18.))
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
            .child(heading("How they see you"))
            .child(tone_text(&note))
            .child(labeled("Your name", input(&self.seen_name, cx)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(div().flex().gap(px(8.)).child(a).child(b).child(c).child(d))
                    .child(div().flex().gap(px(8.)).child(e).child(f).child(g).child(h)),
            )
            .child(preview_frame(if name.is_empty() { "You" } else { &name }, color))
            .when_some(self.seen_error.clone(), |el, error| el.child(danger_text(error)))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        pill("seen-as-cancel", "Cancel", None, None, false)
                            .flex_1()
                            .on_click(cx.listener(|this, _, _, cx| this.close_seen_as(cx))),
                    )
                    .child(
                        pill(
                            "seen-as-save",
                            if self.seen_busy { "Saving…" } else { save_label },
                            None,
                            Some(color),
                            !ready,
                        )
                        .flex_1()
                        .when(ready, |pill| {
                            pill.on_click(cx.listener(|this, _, _, cx| this.save_seen_as(cx)))
                        }),
                    ),
            )
            .into_any_element()
    }

    /// Stops tapping them from every device on the account (or just this PC,
    /// signed out). Stays open with the error, to try again.
    fn remove(&mut self, id: String, cx: &mut Context<Self>) {
        self.busy = true;
        self.action_error = None;
        let account = self.account(cx);
        let target = id.clone();
        let task = cx.background_executor().spawn(async move { account.remove(&target) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(()) => this.after_removing(&id, cx),
                    Err(error) => this.action_error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn delete_data(&mut self, id: String, cx: &mut Context<Self>) {
        self.busy = true;
        self.action_error = None;
        let target = id.clone();
        self.run(
            cx,
            move |senders| senders.delete_data(&target),
            move |this, result, cx| {
                this.busy = false;
                match result {
                    Ok(()) => this.after_removing(&id, cx),
                    // Stays open with the error, to try again.
                    Err(error) => this.action_error = Some(error.to_string()),
                }
            },
        );
    }

    fn after_removing(&mut self, id: &str, cx: &mut Context<Self>) {
        self.drafts.remove(id);
        self.selected = None;
        self.confirming = None;
        let state = self.model.read(cx).sender_state.clone();
        match state.sessions.iter().find(|session| session.id() != id) {
            Some(next) => self.select(next.id().to_string(), cx),
            None => self.start_adding(cx),
        }
    }
}

impl Focusable for SendView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SendView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(focus) = self.pending_focus.take() {
            let field = match focus {
                Focus::Composer => &self.composer,
                Focus::Invite => &self.invite,
            };
            window.focus(&field.focus_handle(cx));
        }
        let state = self.model.read(cx).sender_state.clone();
        let current = self.current(&state);
        let frame = current
            .as_ref()
            .map(SenderSession::color)
            .unwrap_or_else(|| self.own_color(cx));
        let page: Vec<AnyElement> = match &current {
            Some(session) if self.style_open => self.style_page(session, window, cx),
            Some(session) => self.composer_page(session, &state, window, cx),
            None => self.accept_page(&state, frame, cx),
        };
        div()
            .id("send")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(theme::base(frame))
            .text_color(paper::ink())
            .font_family(BRICOLAGE)
            .text_size(px(15.))
            .child(self.frame_bar(frame, &state, current.as_ref(), cx))
            .child(
                div().flex_1().min_h_0().px(px(10.)).pb(px(10.)).child(
                    div()
                        .id("page")
                        .size_full()
                        .rounded(px(22.))
                        .bg(paper::paper())
                        .overflow_y_scroll()
                        .child(div().flex().flex_col().gap(px(20.)).p(px(24.)).children(page)),
                ),
            )
    }
}

// The frame

impl SendView {
    /// The mark, then everyone you can tap and Add someone, in the frame's ink.
    fn frame_bar(
        &mut self,
        frame: PersonColor,
        state: &SenderState,
        current: Option<&SenderSession>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let ink: Hsla = theme::ink(frame).into();
        let chips = state.sessions.iter().map(|session| {
            let id = session.id().to_string();
            let selected = current.is_some_and(|current| current.id() == id);
            div()
                .id(SharedString::from(format!("person-{id}")))
                .size(px(38.))
                .p(px(2.))
                .rounded_full()
                .border_2()
                .border_color(if selected { ink } else { gpui::transparent_black() })
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
                .child(
                    avatar(&session.pairing.recipient_name, session.color(), 30.)
                        .border_1()
                        .border_color(ink.opacity(if selected { 0. } else { 0.35 })),
                )
        });
        let adding = current.is_none();
        let add = div()
            .id("add-person")
            .size(px(38.))
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .border_2()
            .border_color(ink.opacity(if adding { 1. } else { 0.35 }))
            .cursor_pointer()
            .hover(|style| style.bg(ink.opacity(0.12)))
            .on_click(cx.listener(|this, _, _, cx| this.start_adding(cx)))
            .child(svg().path(Icon::Invite.path()).size(px(19.)).text_color(ink));
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
            .children(chips)
            .child(add)
    }
}

// Composer

impl SendView {
    fn composer_page(
        &mut self,
        session: &SenderSession,
        state: &SenderState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let recipient = session.pairing.recipient_name.clone();
        let color = session.color();
        let draft = self.composer.read(cx).text().to_string();
        let empty = draft.trim().is_empty();
        let remaining = MAX_TAP_LENGTH as i64 - draft.chars().count() as i64;
        self.composer.update(cx, |field, _| {
            field.set_placeholder(format!("What does {recipient} need to know?"))
        });

        let mut page: Vec<AnyElement> = vec![
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .font_weight(FontWeight::EXTRA_BOLD)
                        .text_size(px(30.))
                        .line_height(px(32.))
                        .child(format!("Tap {recipient}")),
                )
                .child(status_label(session.status))
                .into_any_element(),
        ];
        if let Some(notice) = state.notice.clone() {
            page.insert(0, self.notice(notice, cx));
        }
        if let Some(connected) = self.connected.clone() {
            page.insert(0, self.connected_banner(connected, cx));
        }

        let focus = self.composer.focus_handle(cx);
        let field = div()
            .relative()
            .w_full()
            .px(px(16.))
            .py(px(12.))
            .rounded(px(18.))
            .bg(paper::faint())
            .text_size(px(17.))
            .line_height(px(23.))
            .cursor_text()
            .on_mouse_down(MouseButton::Left, move |_, window, _| window.focus(&focus))
            .child(self.composer.clone())
            .when(remaining <= COUNTDOWN_FROM as i64, |field| {
                field.child(
                    div()
                        .absolute()
                        .bottom(px(8.))
                        .right(px(12.))
                        .text_size(px(13.))
                        .text_color(paper::tone())
                        .child(remaining.to_string()),
                )
            });
        let send = pill("send", "Send tap", Some(Icon::Send), Some(color), empty)
            .w_full()
            .when(!empty, |pill| {
                pill.on_click(cx.listener(|this, _, _, cx| this.send(cx)))
            });
        page.push(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(field)
                .child(send)
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .text_size(px(12.))
                        .text_color(paper::tone())
                        .child("Ctrl+Enter sends"),
                )
                .when_some(self.send_error.clone(), |el, error| el.child(danger_text(error)))
                .child(self.style_row(session, &draft, window, cx))
                .into_any_element(),
        );

        if let Some(nudge) = self.nudge(color, window, cx) {
            page.push(nudge);
        }
        page.push(self.recent(session, cx));
        page.push(self.options(session, cx));
        page
    }

    fn notice(&mut self, notice: String, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(14.))
            .py(px(10.))
            .rounded(px(16.))
            .bg(paper::faint())
            .child(div().flex_1().text_size(px(14.)).child(notice))
            .child(
                pill("notice-ok", "OK", None, None, false).on_click(cx.listener(|this, _, _, cx| {
                    this.senders(cx).clear_notice();
                })),
            )
            .into_any_element()
    }

    fn connected_banner(&mut self, message: String, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(14.))
            .py(px(10.))
            .rounded(px(16.))
            .bg(paper::faint())
            .child(
                div()
                    .flex_1()
                    .font_weight(FontWeight::BOLD)
                    .text_size(px(14.))
                    .child(message),
            )
            .child(
                pill("connected-ok", "OK", None, None, false).on_click(cx.listener(|this, _, _, cx| {
                    this.connected = None;
                    cx.notify();
                })),
            )
            .into_any_element()
    }

    fn recent(&mut self, session: &SenderSession, cx: &mut Context<Self>) -> AnyElement {
        let recipient = session.pairing.recipient_name.clone();
        let color = session.color();
        let mut rows: Vec<AnyElement> = Vec::new();
        for item in &session.outbox {
            rows.push(self.outbox_row(session.id(), item, color, cx));
        }
        for tap in &session.taps {
            rows.push(self.tap_row(session.id(), tap, &recipient, color, cx));
        }
        let empty = rows.is_empty();
        div()
            .flex()
            .flex_col()
            .child(heading("Recent"))
            .children(rows)
            .when(empty && session.loaded, |el| {
                el.child(
                    div()
                        .pt(px(8.))
                        .text_size(px(14.))
                        .text_color(paper::tone())
                        .child(format!(
                            "Nothing sent yet. Your taps and {recipient}'s answers show up here."
                        )),
                )
            })
            .when_some(
                self.action_error.clone().filter(|_| self.confirming.is_none()),
                |el, error| el.child(div().pt(px(8.)).child(danger_text(error))),
            )
            .into_any_element()
    }

    fn outbox_row(&mut self, id: &str, item: &OutgoingTap, color: PersonColor, cx: &mut Context<Self>) -> AnyElement {
        let status: AnyElement = if item.failed {
            let (discard_id, retry_id) = (id.to_string(), id.to_string());
            let (discard_request, retry_request) = (item.request_id.clone(), item.request_id.clone());
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(14.))
                        .text_color(danger())
                        .child(item.error.clone().unwrap_or_else(|| "Couldn't send".into())),
                )
                .child(
                    pill(
                        SharedString::from(format!("discard-{}", item.request_id)),
                        "Discard",
                        None,
                        None,
                        false,
                    )
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.senders(cx).discard(&discard_id, &discard_request)),
                    ),
                )
                .child(
                    pill(
                        SharedString::from(format!("retry-{}", item.request_id)),
                        "Try again",
                        None,
                        Some(color),
                        false,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.senders(cx).retry(&retry_id, &retry_request))),
                )
                .into_any_element()
        } else {
            track(0, color).into_any_element()
        };
        list_row().child(message(&item.body)).child(status).into_any_element()
    }

    fn tap_row(
        &mut self,
        id: &str,
        tap: &Tap,
        recipient: &str,
        color: PersonColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let group: SharedString = format!("tap-{}", tap.id).into();
        let progress: AnyElement = match (&tap.response, tap.acknowledged_at) {
            (Some(response), Some(acknowledged_at)) if tap.state == TapState::Acknowledged => answer_card(
                response.kind,
                response.label(),
                tap.created_at,
                acknowledged_at,
                tap.acknowledged_by.clone(),
            )
            .into_any_element(),
            _ => track(if tap.displayed_at.is_none() { 1 } else { 2 }, color).into_any_element(),
        };
        let tap_id = tap.id.clone();
        let remove = div()
            .id(SharedString::from(format!("delete-{}", tap.id)))
            .size(px(24.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .cursor_pointer()
            .invisible()
            .group_hover(group.clone(), |style| style.visible())
            .hover(|style| style.bg(paper::faint()))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.action_error = None;
                this.confirming = Some(Confirm::Tap(tap_id.clone()));
                cx.notify();
            }))
            .child(svg().path(Icon::Remove.path()).size(px(15.)).text_color(paper::tone()));
        let confirming = self.confirming == Some(Confirm::Tap(tap.id.clone()));
        let row = list_row()
            .group(group)
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .child(message(&tap.body).flex_1().min_w_0())
                    .child(
                        div()
                            .pt(px(3.))
                            .text_size(px(13.))
                            .text_color(paper::tone())
                            .child(theme::ago(tap.created_at, now_ms())),
                    )
                    .child(remove),
            )
            .child(progress);
        if !confirming {
            return row.into_any_element();
        }
        let explanation = if tap.state == TapState::Pending {
            format!("It's taken back from {recipient}'s screens before they answer, and removed for both of you.")
        } else {
            format!("It's removed for both of you, along with {recipient}'s answer.")
        };
        let (id, tap_id) = (id.to_string(), tap.id.clone());
        row.child(self.confirmation(
            "Delete this tap?",
            explanation,
            "Delete",
            move |this, cx| this.delete_tap(id.clone(), tap_id.clone(), cx),
            cx,
        ))
        .into_any_element()
    }

    fn options(&mut self, session: &SenderSession, cx: &mut Context<Self>) -> AnyElement {
        let recipient = session.pairing.recipient_name.clone();
        let id = session.id().to_string();
        let seen = Profile {
            name: session.pairing.sender_name.clone(),
            color: session.color(),
        };
        let editing = self.seen_edit == Some(SeenAsEdit::Person(id.clone()));
        let editor = editing.then(|| {
            self.seen_as_editor(
                format!("Only {recipient} sees this. It changes your taps they already have too."),
                "Save",
                cx,
            )
        });
        let edit_id = id.clone();
        let buttons = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .child(
                pill("seen-as", "How they see you", None, None, false).on_click(cx.listener(move |this, _, _, cx| {
                    this.open_seen_as(SeenAsEdit::Person(edit_id.clone()), seen.clone(), cx)
                })),
            )
            .child(
                pill("remove", &format!("Remove {recipient}"), None, None, false).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.action_error = None;
                        this.confirming = Some(Confirm::Remove);
                        cx.notify();
                    },
                )),
            )
            .child(
                pill("delete-data", "Delete my data", None, None, false).on_click(cx.listener(|this, _, _, cx| {
                    this.action_error = None;
                    this.confirming = Some(Confirm::DeleteData);
                    cx.notify();
                })),
            );
        let confirmation = match self.confirming {
            Some(Confirm::Remove) => Some(self.confirmation(
                &format!("Stop tapping {recipient}?"),
                format!("You stop tapping {recipient} from all your devices. They can still tap you. To connect again, you'll need a new invite."),
                "Remove",
                move |this, cx| this.remove(id.clone(), cx),
                cx,
            )),
            Some(Confirm::DeleteData) => Some(self.confirmation(
                "Delete your data?",
                format!("Removes you and every tap you sent from {recipient}'s inbox, then removes them here."),
                "Delete",
                move |this, cx| this.delete_data(id.clone(), cx),
                cx,
            )),
            _ => None,
        };
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(heading("Options"))
            .child(div().text_size(px(13.)).text_color(paper::tone()).child(format!(
                "You're {} on {recipient}'s devices.",
                session.pairing.sender_name
            )))
            .child(buttons)
            .children(editor)
            .children(confirmation)
            .into_any_element()
    }

    /// Asks once more before something that can't be undone.
    fn confirmation(
        &mut self,
        title: &str,
        explanation: String,
        confirm_label: &'static str,
        confirm: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let busy = self.busy;
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(14.))
            .rounded(px(16.))
            .bg(paper::faint())
            .child(div().font_weight(FontWeight::BOLD).child(title.to_string()))
            .child(div().text_size(px(14.)).text_color(paper::tone()).child(explanation))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        danger_pill("confirm", if busy { "Working…" } else { confirm_label }, busy)
                            .when(!busy, |pill| {
                                pill.on_click(cx.listener(move |this, _, _, cx| confirm(this, cx)))
                            }),
                    )
                    .child(
                        pill("cancel-confirm", "Cancel", None, None, false).on_click(cx.listener(|this, _, _, cx| {
                            this.confirming = None;
                            cx.notify();
                        })),
                    ),
            )
            .when_some(self.action_error.clone(), |el, error| el.child(danger_text(error)))
            .into_any_element()
    }
}

// Patron themes

impl SendView {
    fn open_style(&mut self, cx: &mut Context<Self>) {
        self.style_open = true;
        self.style_selected = self.model.read(cx).patron_state.sending_theme();
        self.style_started = Instant::now();
        self.patron_error = None;
        self.model.read(cx).refresh_patron();
        cx.notify();
    }

    /// Development snapshots: as if a tap just went out from here, and with
    /// a theme picked in the Style sheet.
    #[cfg(not(windows))]
    pub(crate) fn snapshot(&mut self, sent: bool, style: Option<TapTheme>) {
        self.sent_here = sent;
        if let Some(theme) = style {
            self.style_open = true;
            self.style_selected = theme;
        }
    }

    /// Checkout in the browser; coming back refreshes the membership.
    fn become_patron(&mut self, cx: &mut Context<Self>) {
        if self.patron_busy {
            return;
        }
        self.patron_busy = true;
        self.patron_error = None;
        let patrons = self.patron(cx);
        let task = cx.background_executor().spawn(async move { patrons.checkout() });
        self.open_in_browser(task, cx);
    }

    fn manage_billing(&mut self, cx: &mut Context<Self>) {
        if self.patron_busy {
            return;
        }
        self.patron_busy = true;
        self.patron_error = None;
        let patrons = self.patron(cx);
        let task = cx.background_executor().spawn(async move { patrons.manage() });
        self.open_in_browser(task, cx);
    }

    fn open_in_browser(&mut self, task: Task<Result<String, ApiError>>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.patron_busy = false;
                match result {
                    Ok(url) => cx.open_url(&url),
                    Err(error) => this.patron_error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Dismissed or acted on: counts as shown, then fades.
    fn dismiss_nudge(&mut self, cx: &mut Context<Self>) {
        self.patron(cx).nudge_shown();
        let reduce = patron::reduces_motion(self.model.read(cx));
        self.nudge_fade = (!reduce).then(Instant::now);
        cx.notify();
    }

    /// The Style row: a live thumbnail of the draft in the theme it goes in,
    /// or the patron themes cycling while it goes in Default.
    fn style_row(
        &mut self,
        session: &SenderSession,
        draft: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let model = self.model.read(cx);
        let chosen = model.patron_state.sending_theme();
        let reduce = patron::reduces_motion(model);
        let (shown, elapsed, title, subtitle) = if chosen.is_paid() {
            (
                chosen,
                SETTLED,
                format!("Style: {}", chosen.label()),
                "How everyone you tap sees it",
            )
        } else {
            let (shown, elapsed) = patron::cycle_at(self.cycle_started, reduce);
            (shown, elapsed, format!("Send it as {}", shown.label()), "Patron themes")
        };
        let body = if draft.trim().is_empty() {
            patron::SAMPLE
        } else {
            draft.trim()
        };
        let thumbnail = patron::preview(
            shown,
            patron::sample(&session.pairing.sender_name, session.color(), body),
            THUMB_W,
            THUMB_H,
            elapsed,
            reduce,
            &self.preview_reply,
            8.,
            window,
            cx,
        );
        div()
            .id("style-row")
            .flex()
            .items_center()
            .gap(px(12.))
            .p(px(8.))
            .rounded(px(16.))
            .bg(paper::faint())
            .cursor_pointer()
            .hover(|style| style.bg(paper::line()))
            .on_click(cx.listener(|this, _, _, cx| this.open_style(cx)))
            .child(thumbnail)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(div().font_weight(FontWeight::BOLD).text_size(px(15.)).child(title))
                    .child(tone_text(subtitle).text_size(px(13.))),
            )
            .child(
                div()
                    .pr(px(8.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(paper::tone())
                    .child("›"),
            )
            .into_any_element()
    }

    /// After a send, now and then: a quiet ask. Never on a received tap.
    fn nudge(&mut self, color: PersonColor, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let opacity = match self.nudge_fade {
            Some(at) => {
                let t = at.elapsed().as_secs_f32() / NUDGE_FADE;
                if t >= 1. {
                    self.nudge_fade = None;
                    return None;
                }
                window.request_animation_frame();
                1. - t
            }
            None if self.sent_here && self.model.read(cx).patron_state.nudge_due() => 1.,
            None => return None,
        };
        let fading = self.nudge_fade.is_some();
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .p(px(16.))
                .rounded(px(16.))
                .bg(paper::faint())
                .opacity(opacity)
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(17.))
                        .child("Enjoying Shouldertap?"),
                )
                .child(tone_text(
                    "It's free, and patrons keep it that way. If you'd like to chip in $2 a month, your taps can arrive in Broadsheet, Billboard, Terminal or Note.",
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            pill("nudge-patron", "Become a patron", None, Some(color), fading).when(!fading, |pill| {
                                pill.on_click(cx.listener(|this, _, _, cx| {
                                    this.become_patron(cx);
                                    this.dismiss_nudge(cx);
                                }))
                            }),
                        )
                        .child(
                            div()
                                .id("nudge-not-now")
                                .px(px(12.))
                                .font_weight(FontWeight::BOLD)
                                .text_size(px(14.))
                                .text_color(paper::tone())
                                .when(!fading, |button| {
                                    button
                                        .cursor_pointer()
                                        .hover(|style| style.text_color(paper::ink()))
                                        .on_click(cx.listener(|this, _, _, cx| this.dismiss_nudge(cx)))
                                })
                                .child("Not now"),
                        ),
                )
                .into_any_element(),
        )
    }

    /// Tap style: how your taps look on everyone's screens, chosen here.
    fn style_page(&mut self, session: &SenderSession, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let model = self.model.read(cx);
        let state = model.patron_state.clone();
        let signed_in = model.account_state.signed_in;
        let reduce = patron::reduces_motion(model);
        let color = session.color();
        let name = session.pairing.sender_name.clone();
        let selected = self.style_selected;
        let in_use = state.sending_theme();

        let width = (f32::from(window.viewport_size().width) - 20. - 48.).max(240.);
        let preview = patron::preview(
            selected,
            patron::sample(&name, color, patron::SAMPLE),
            width,
            width * 900. / 1440.,
            self.style_started.elapsed().as_secs_f32(),
            reduce,
            &self.preview_reply,
            14.,
            window,
            cx,
        );
        let mut page: Vec<AnyElement> = vec![
            page_heading(
                "Tap style",
                "How your taps look on the screens of everyone you tap. They never pay to see it.",
            ),
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(preview)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .child(div().flex_1().font_weight(FontWeight::BOLD).child(selected.label()))
                        .child(pill("style-replay", "Replay", None, None, false).on_click(cx.listener(
                            |this, _, _, cx| {
                                this.style_started = Instant::now();
                                cx.notify();
                            },
                        ))),
                )
                .into_any_element(),
        ];

        let mut rows = div().flex().flex_col();
        for theme in TapTheme::ALL {
            let mut subtitle = patron::subtitle(theme).to_string();
            if theme.is_paid() && !state.active {
                subtitle.push_str(" · Patrons");
            }
            if theme == in_use {
                subtitle.push_str(" · in use");
            }
            let thumbnail = patron::preview(
                theme,
                patron::sample(&name, color, patron::SAMPLE),
                THUMB_W,
                THUMB_H,
                SETTLED,
                true,
                &self.preview_reply,
                8.,
                window,
                cx,
            );
            let chosen = theme == selected;
            rows = rows.child(
                div()
                    .id(SharedString::from(format!("style-{}", theme.label())))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .p(px(8.))
                    .rounded(px(16.))
                    .border_2()
                    .border_color(if chosen {
                        paper::ink().into()
                    } else {
                        gpui::transparent_black()
                    })
                    .cursor_pointer()
                    .hover(|style| style.bg(paper::faint()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.style_selected = theme;
                        this.style_started = Instant::now();
                        cx.notify();
                    }))
                    .child(thumbnail)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().font_weight(FontWeight::BOLD).child(theme.label()))
                            .child(tone_text(&subtitle).text_size(px(13.))),
                    ),
            );
        }
        page.push(rows.into_any_element());

        let label = selected.label();
        let busy = self.patron_busy;
        let action: AnyElement = if selected == in_use {
            div()
                .font_weight(FontWeight::BOLD)
                .child(format!("Your taps use {label}."))
                .into_any_element()
        } else if state.can_use(selected) {
            pill("style-use", &format!("Use {label}"), None, Some(color), false)
                .w_full()
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.patron(cx).set_theme(selected);
                    cx.notify();
                }))
                .into_any_element()
        } else if state.checkout_enabled && signed_in {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    pill(
                        "style-become-patron",
                        &format!("Become a patron to use {label}"),
                        None,
                        Some(color),
                        busy,
                    )
                    .w_full()
                    .when(!busy, |pill| {
                        pill.on_click(cx.listener(|this, _, _, cx| this.become_patron(cx)))
                    }),
                )
                .child(tone_text(patron::STYLE_PRICE).text_size(px(13.)))
                .into_any_element()
        } else if !signed_in {
            tone_text("Sign in to become a patron.").into_any_element()
        } else {
            tone_text("Patron memberships open soon.").into_any_element()
        };
        page.push(action);

        let membership: AnyElement = if state.active {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .child("Thank you for being a patron."),
                )
                .children(
                    state
                        .membership
                        .as_ref()
                        .and_then(patron::renewal)
                        .map(|renewal| tone_text(&renewal)),
                )
                .child(div().flex().pt(px(4.)).child(
                    pill("style-manage", "Manage billing", None, None, busy).when(!busy, |pill| {
                        pill.on_click(cx.listener(|this, _, _, cx| this.manage_billing(cx)))
                    }),
                ))
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .children(patron::PERKS.map(tone_text))
                .into_any_element()
        };
        page.push(membership);
        if let Some(error) = self.patron_error.clone() {
            page.push(danger_text(error).into_any_element());
        }
        page.push(
            div()
                .flex()
                .child(
                    pill("style-done", "Done", None, Some(color), false)
                        .flex_1()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.style_open = false;
                            this.pending_focus = Some(Focus::Composer);
                            cx.notify();
                        })),
                )
                .into_any_element(),
        );
        page
    }
}

// Accepting an invite

impl SendView {
    /// Paste an invite link, see who sent it, accept. Your name and color
    /// come from your account, so there's nothing else to fill in.
    fn accept_page(&mut self, state: &SenderState, frame: PersonColor, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let account = self.model.read(cx).account_state.clone();
        let first = state.sessions.is_empty();
        let mut page: Vec<AnyElement> = Vec::new();
        if let Some(notice) = state.notice.clone() {
            page.push(self.notice(notice, cx));
        }
        if let Some(connected) = self.connected.clone() {
            page.push(self.connected_banner(connected, cx));
        }
        let title = if first { "Tap someone" } else { "Add someone" };
        if !account.signed_in || account.needs_profile() {
            let (body, label, step) = if account.signed_in {
                (
                    "Pick your name and color first: they frame every tap you send.",
                    "Finish setting up",
                    WelcomeStep::You,
                )
            } else {
                (
                    "Sign in to accept invites. The people you connect with follow you to every device.",
                    "Sign in",
                    WelcomeStep::Email,
                )
            };
            page.push(page_heading(title, body));
            page.push(
                pill("sign-in", label, None, Some(frame), false)
                    .w_full()
                    .on_click(move |_, _, cx| Shell::open_welcome(step, cx))
                    .into_any_element(),
            );
            return page;
        }

        page.push(page_heading(
            title,
            "Got a link? Paste the invite they sent you. You'll be connected both ways.",
        ));
        page.push(labeled("Invite link", input(&self.invite, cx)));
        let code = invite_code(self.invite.read(cx).text());
        match self.preview.clone() {
            Some((_, Some(preview))) => {
                let color = preview.color.unwrap_or(frame);
                page.push(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(
                            div()
                                .font_weight(FontWeight::BOLD)
                                .text_size(px(17.))
                                .child(format!("{} invited you to Shouldertap", preview.name)),
                        )
                        .child(preview_frame(&preview.name, color))
                        .into_any_element(),
                );
                if self.seen_edit == Some(SeenAsEdit::Invite) {
                    let note = format!(
                        "Only {} sees this. Everyone else keeps seeing you as before.",
                        preview.name
                    );
                    page.push(self.seen_as_editor(note, "Use for them", cx));
                } else if let Some(profile) = self.seen_as.clone().or_else(|| self.send_default(cx)) {
                    page.push(self.seen_as_row("They'll see you as", profile, SeenAsEdit::Invite, cx));
                }
            }
            Some((_, None)) => page.push(tone_text("Looking up the invite…").into_any_element()),
            None if !self.invite.read(cx).text().trim().is_empty() => {
                page.push(danger_text("That doesn't look like a Shouldertap invite link.".into()).into_any_element())
            }
            None => {}
        }
        if let Some(error) = self.accept_error.clone() {
            page.push(danger_text(error).into_any_element());
        }
        let ready = code.is_some() && !self.accepting && self.seen_edit != Some(SeenAsEdit::Invite);
        page.push(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    pill(
                        "accept",
                        if self.accepting { "Accepting…" } else { "Accept" },
                        None,
                        Some(frame),
                        !ready,
                    )
                    .w_full()
                    .when(ready, |pill| {
                        pill.on_click(cx.listener(|this, _, _, cx| this.accept(cx)))
                    }),
                )
                .when(!first, |el| {
                    el.child(
                        pill("cancel-accept", "Cancel", None, None, false)
                            .w_full()
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_adding(cx))),
                    )
                })
                .into_any_element(),
        );
        page
    }
}

// Pieces

fn danger() -> Hsla {
    gpui::rgb(0xc42b1c).into()
}

/// A page's title and what to do, in tone.
pub(crate) fn page_heading(title: &str, body: &str) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_size(px(30.))
                .line_height(px(32.))
                .child(title.to_string()),
        )
        .child(tone_text(body))
        .into_any_element()
}

pub(crate) fn tone_text(text: &str) -> gpui::Div {
    div()
        .text_size(px(14.))
        .text_color(paper::tone())
        .child(text.to_string())
}

pub(crate) fn danger_text(text: String) -> impl IntoElement {
    div().text_size(px(14.)).text_color(danger()).child(text)
}

fn heading(text: &str) -> impl IntoElement {
    div()
        .pb(px(4.))
        .font_weight(FontWeight::BOLD)
        .text_size(px(14.))
        .text_color(paper::tone())
        .child(text.to_string())
}

pub(crate) fn labeled(label: &str, content: impl IntoElement) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .font_weight(FontWeight::BOLD)
                .text_size(px(14.))
                .child(label.to_string()),
        )
        .child(content)
        .into_any_element()
}

/// A field: `faint` fill, radius 18, no border (docs/design.md).
pub(crate) fn input(field: &Entity<TextField>, cx: &App) -> AnyElement {
    let focus = field.focus_handle(cx);
    div()
        .w_full()
        .h(px(46.))
        .px(px(16.))
        .flex()
        .items_center()
        .rounded(px(18.))
        .bg(paper::faint())
        .text_size(px(17.))
        .cursor_text()
        .on_mouse_down(MouseButton::Left, move |_, window, _| window.focus(&focus))
        .child(field.clone())
        .into_any_element()
}

fn list_row() -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .py(px(16.))
        .border_b_1()
        .border_color(paper::line())
}

fn message(body: &str) -> gpui::Div {
    div()
        .font_weight(FontWeight::BOLD)
        .text_size(px(19.))
        .line_height(px(24.))
        .child(body.to_string())
}

/// Every action is a pill: filled in a person's color with their ink, or a
/// 1.5px `line` outline with ink text (docs/design.md, "Pills").
pub(crate) fn pill(
    id: impl Into<SharedString>,
    title: &str,
    icon: Option<Icon>,
    color: Option<PersonColor>,
    disabled: bool,
) -> gpui::Stateful<gpui::Div> {
    let foreground: Hsla = color.map(theme::ink).unwrap_or(paper::ink()).into();
    let pill = div()
        .id(id.into())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .h(px(color.map_or(38., |_| 48.)))
        .px(px(18.))
        .rounded_full()
        .font_weight(FontWeight::BOLD)
        .text_color(foreground)
        .map(|pill| match color {
            Some(color) => pill.bg(theme::base(color)),
            None => pill.border_2().border_color(paper::line()),
        })
        .children(icon.map(|icon| svg().path(icon.path()).size(px(19.)).text_color(foreground)))
        .child(title.to_string());
    if disabled {
        pill.opacity(0.4)
    } else {
        pill.cursor_pointer()
            .map(|pill| match color {
                Some(_) => pill.hover(|style| style.opacity(0.9)),
                None => pill.hover(|style| style.border_color(paper::ink())),
            })
            .active(|style| style.opacity(0.7))
    }
}

fn danger_pill(id: &'static str, title: &str, disabled: bool) -> gpui::Stateful<gpui::Div> {
    let pill = div()
        .id(id)
        .flex()
        .items_center()
        .h(px(38.))
        .px(px(18.))
        .rounded_full()
        .bg(danger())
        .text_color(gpui::white())
        .font_weight(FontWeight::BOLD)
        .child(title.to_string());
    if disabled {
        pill.opacity(0.5)
    } else {
        pill.cursor_pointer().hover(|style| style.opacity(0.9))
    }
}

fn avatar(name: &str, color: PersonColor, size: f32) -> gpui::Div {
    div()
        .size(px(size))
        .flex_none()
        .rounded_full()
        .bg(theme::base(color))
        .flex()
        .items_center()
        .justify_center()
        .font_weight(FontWeight::BOLD)
        .text_size(px(size * 0.45))
        .text_color(theme::ink(color))
        .child(initial(name))
}

fn initial(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_else(|| "?".into())
}

fn status_label(status: LiveStatus) -> impl IntoElement {
    let (label, color): (&str, Hsla) = match status {
        LiveStatus::Live => ("Live", theme::live_green().into()),
        LiveStatus::Connecting => ("Connecting", paper::tone().into()),
        LiveStatus::Offline => ("Offline", paper::tone().into()),
    };
    div()
        .flex()
        .items_center()
        .gap(px(7.))
        .font_weight(FontWeight::BOLD)
        .text_size(px(13.))
        .text_color(paper::tone())
        .child(div().size(px(8.)).rounded_full().bg(color))
        .child(label)
}

/// Three segments in the person's color: Sent, On screen, Answered. The step
/// in progress is drawn lighter rather than pulsing, so an open window never
/// redraws every frame for a tap that waits all afternoon.
fn track(reached: usize, color: PersonColor) -> impl IntoElement {
    const STEPS: [&str; 3] = ["Sent", "On screen", "Answered"];
    let segments = (0..3).map(|step| {
        let fill: Hsla = if step <= reached {
            theme::base(color).into()
        } else {
            paper::faint().into()
        };
        div()
            .flex_1()
            .h(px(5.))
            .rounded_full()
            .bg(fill)
            .when(step == reached, |segment| segment.opacity(0.45))
    });
    let labels = (0..3).map(|step| {
        div()
            .flex_1()
            .text_color(if step + 1 == reached {
                paper::ink()
            } else {
                paper::tone()
            })
            .child(STEPS[step])
    });
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(div().flex().gap(px(4.)).children(segments))
        .child(
            div()
                .flex()
                .gap(px(4.))
                .font_weight(FontWeight::BOLD)
                .text_size(px(12.))
                .children(labels),
        )
}

/// The answer card: icon, answer, how long it took and on which device.
fn answer_card(
    kind: ResponseKind,
    label: String,
    created_at: Timestamp,
    acknowledged_at: Timestamp,
    by: Option<String>,
) -> impl IntoElement {
    let icon = match kind {
        ResponseKind::OnIt => Icon::OnIt,
        ResponseKind::In10 => Icon::In10,
        ResponseKind::Text => Icon::Reply,
    };
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(14.))
        .py(px(12.))
        .rounded(px(16.))
        .bg(paper::faint())
        .child(
            svg()
                .path(icon.path())
                .size(px(20.))
                .flex_none()
                .text_color(paper::ink()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .font_weight(FontWeight::BOLD)
                .text_size(px(17.))
                .child(label),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .items_end()
                .text_size(px(13.))
                .text_color(paper::tone())
                .child(format!("{} later", theme::duration(created_at, acknowledged_at)))
                .children(by.map(|by| format!("on {by}"))),
        )
}

/// How taps look on screen: the sender's name on their color's frame.
pub(crate) fn preview_frame(name: &str, color: PersonColor) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .rounded(px(18.))
        .bg(theme::base(color))
        .px(px(9.))
        .pb(px(9.))
        .child(
            div()
                .h(px(34.))
                .px(px(8.))
                .flex()
                .items_center()
                .font_weight(FontWeight::BOLD)
                .text_size(px(15.))
                .text_color(theme::ink(color))
                .child(name.to_string()),
        )
        .child(
            div()
                .rounded(px(12.))
                .bg(paper::paper())
                .px(px(18.))
                .py(px(22.))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_size(px(30.))
                .line_height(px(30.))
                .child("Dinner's ready"),
        )
}

/// One line about where things stand with a person, for the menu: the
/// latest send or answer.
pub fn latest_status(session: &SenderSession, now: Timestamp) -> String {
    if let Some(item) = session.outbox.first() {
        return if item.failed {
            "Couldn't send".into()
        } else {
            "Sending…".into()
        };
    }
    let Some(tap) = session.taps.first() else {
        return match (session.loaded, session.status) {
            (true, _) => "Nothing sent yet".into(),
            (false, LiveStatus::Offline) => "Offline".into(),
            (false, _) => "Connecting…".into(),
        };
    };
    match (&tap.response, tap.acknowledged_at) {
        (Some(response), Some(at)) if tap.state == TapState::Acknowledged => {
            format!("{} · {}", response.label(), theme::ago(at, now))
        }
        _ if tap.displayed_at.is_some() => format!("On screen · {}", theme::ago(tap.created_at, now)),
        _ => format!("Sent · {}", theme::ago(tap.created_at, now)),
    }
}

impl Shell {
    /// Opens the Send window on a person or the pairing form.
    pub fn open_send(target: SendTarget, cx: &mut App) {
        Shell::close_menu(cx);
        if let Some(handle) = cx.global::<Shell>().send
            && handle
                .update(cx, |view, window, cx| {
                    view.show(target.clone(), cx);
                    window.activate_window();
                })
                .is_ok()
        {
            return;
        }
        let model = cx.global::<Shell>().model.clone();
        let bounds = gpui::Bounds::centered(None, gpui::size(px(520.), px(760.)), cx);
        let handle = cx
            .open_window(
                gpui::WindowOptions {
                    window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Tap Someone".into()),
                        ..Default::default()
                    }),
                    focus: true,
                    show: true,
                    is_resizable: true,
                    window_min_size: Some(gpui::size(px(420.), px(520.))),
                    app_id: Some(crate::config::APP_ID.into()),
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| SendView::new(model, target, window, cx)),
            )
            .ok();
        if let Some(handle) = handle {
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
        cx.global_mut::<Shell>().send = handle;
    }

    /// Settings → Choose tap style: the Style sheet, or the Send window
    /// when there's no one to tap yet.
    pub fn open_style(cx: &mut App) {
        let nobody = cx.global::<Shell>().model.read(cx).sender_state.sessions.is_empty();
        Shell::open_send(if nobody { SendTarget::Add } else { SendTarget::Style }, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shouldertap_core::{SenderPairing, TapResponse};

    const NOW: Timestamp = 1_790_790_600_000.0;

    fn session(outbox: Vec<OutgoingTap>, taps: Vec<Tap>, loaded: bool) -> SenderSession {
        SenderSession {
            pairing: SenderPairing {
                token: "inbox123.s1s1s1s1.secret5678".into(),
                credential_id: "s1s1s1s1".into(),
                recipient_name: "Jamie".into(),
                sender_name: "Rosa".into(),
                color: Some(PersonColor::Rose),
                paired_at: 1.0,
                account_id: None,
            },
            taps,
            outbox,
            status: LiveStatus::Connecting,
            loaded,
        }
    }

    fn tap(displayed: bool, response: Option<TapResponse>) -> Tap {
        Tap {
            id: "t1".into(),
            sender_id: "s1".into(),
            sender_name: "Rosa".into(),
            sender_color: PersonColor::Rose,
            body: "Dinner's ready".into(),
            created_at: NOW - 5.0 * 60_000.0,
            state: if response.is_some() {
                TapState::Acknowledged
            } else {
                TapState::Pending
            },
            displayed_at: displayed.then_some(NOW - 4.0 * 60_000.0),
            acknowledged_at: response.as_ref().map(|_| NOW - 2.0 * 60_000.0),
            acknowledged_by: response.as_ref().map(|_| "Studio".into()),
            response,
            sequence: 1,
            theme: None,
        }
    }

    #[test]
    fn the_menu_says_where_things_stand() {
        let queued = OutgoingTap {
            request_id: "r1".into(),
            body: "Hi".into(),
            created_at: NOW,
            failed: false,
            error: None,
            theme: None,
        };
        let failed = OutgoingTap {
            failed: true,
            error: Some("Nope".into()),
            ..queued.clone()
        };
        assert_eq!(latest_status(&session(vec![queued], vec![], true), NOW), "Sending…");
        assert_eq!(
            latest_status(&session(vec![failed], vec![], true), NOW),
            "Couldn't send"
        );
        assert_eq!(latest_status(&session(vec![], vec![], false), NOW), "Connecting…");
        assert_eq!(latest_status(&session(vec![], vec![], true), NOW), "Nothing sent yet");
        assert_eq!(
            latest_status(&session(vec![], vec![tap(false, None)], true), NOW),
            "Sent · 5m ago"
        );
        assert_eq!(
            latest_status(&session(vec![], vec![tap(true, None)], true), NOW),
            "On screen · 5m ago"
        );
        assert_eq!(
            latest_status(&session(vec![], vec![tap(true, Some(TapResponse::in_10()))], true), NOW),
            "In 10 min · 2m ago"
        );
    }
}
