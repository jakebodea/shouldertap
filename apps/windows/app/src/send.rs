//! The Send window: tap the people this PC can tap, like apps/ios's
//! ComposeView and PairFlow (apps/web's tap.tsx and join.tsx). The sender's
//! color frames it (docs/design.md, "Sender (Mac and Windows)"): people as
//! chips on the frame's top edge with Add someone beside them, and the
//! composer or the pairing form on the paper page.

use std::collections::HashMap;
use std::time::Duration;

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, FontWeight, Hsla, MouseButton, Render, SharedString,
    Subscription, Window, div, prelude::*, px, svg,
};
use shouldertap_core::{
    ApiError, LiveStatus, MAX_NAME_LENGTH, MAX_TAP_LENGTH, OutgoingTap, PersonColor, ResponseKind, SenderSession,
    SenderState, SenderStore, Tap, TapState, Timestamp, invite_code, now_ms,
};

use crate::assets::{Icon, MARK_PATH};
use crate::shell::{Model, Shell};
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme::{self, BRICOLAGE, paper};

/// What the window opens on.
#[derive(Clone, Debug, PartialEq)]
pub enum SendTarget {
    Person(String),
    Add,
}

#[derive(Clone, Debug, PartialEq)]
enum Confirm {
    Unpair,
    DeleteData,
    Tap(String),
}

#[derive(Clone, Copy)]
enum Focus {
    Composer,
    Invite,
    Name,
}

/// The countdown appears this close to the limit.
const COUNTDOWN_FROM: usize = 40;

pub struct SendView {
    model: Entity<Model>,
    /// Whose composer shows; the first person when unset or gone.
    selected: Option<String>,
    adding: bool,
    composer: Entity<TextField>,
    /// Unsent drafts by person, while the window is open.
    drafts: HashMap<String, String>,
    send_error: Option<String>,
    // Pairing
    invite: Entity<TextField>,
    name: Entity<TextField>,
    color: PersonColor,
    pairing: bool,
    pair_error: Option<String>,
    // Options and deleting
    confirming: Option<Confirm>,
    busy: bool,
    action_error: Option<String>,
    focus: FocusHandle,
    pending_focus: Option<Focus>,
    _subscriptions: Vec<Subscription>,
}

impl SendView {
    pub fn new(model: Entity<Model>, target: SendTarget, cx: &mut Context<Self>) -> Self {
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
        let name = field(cx, "e.g. Sam", MAX_NAME_LENGTH);
        let subscriptions = vec![
            cx.observe(&model, |_, _, cx| cx.notify()),
            cx.subscribe(&composer, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.send(cx),
                TextFieldEvent::Changed => {
                    this.send_error = None;
                    cx.notify()
                }
                TextFieldEvent::Cancel => {}
            }),
            cx.subscribe(&invite, |this, _, event, cx| match event {
                TextFieldEvent::Submit => {
                    this.pending_focus = Some(Focus::Name);
                    cx.notify();
                }
                TextFieldEvent::Changed => cx.notify(),
                TextFieldEvent::Cancel => this.cancel_adding(cx),
            }),
            cx.subscribe(&name, |this, _, event, cx| match event {
                TextFieldEvent::Submit => this.pair(cx),
                TextFieldEvent::Changed => cx.notify(),
                TextFieldEvent::Cancel => this.cancel_adding(cx),
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
        let mut view = Self {
            model,
            selected: None,
            adding: false,
            composer,
            drafts: HashMap::new(),
            send_error: None,
            invite,
            name,
            color: PersonColor::Cobalt,
            pairing: false,
            pair_error: None,
            confirming: None,
            busy: false,
            action_error: None,
            focus: cx.focus_handle(),
            pending_focus: None,
            _subscriptions: subscriptions,
        };
        view.show(target, cx);
        view
    }

    fn senders(&self, cx: &App) -> SenderStore {
        self.model.read(cx).senders.clone()
    }

    pub fn show(&mut self, target: SendTarget, cx: &mut Context<Self>) {
        match target {
            SendTarget::Person(id) => self.select(id, cx),
            SendTarget::Add => self.start_adding(cx),
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
        let state = self.model.read(cx).sender_state.clone();
        // Pairing with another person reuses the name and color of the last.
        if let Some(last) = state.sessions.last() {
            if self.name.read(cx).text().is_empty() {
                let name = last.pairing.sender_name.clone();
                self.name.update(cx, |field, cx| field.set_text(&name, cx));
            }
            if !self.adding {
                self.color = last.color();
            }
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
        self.pair_error = None;
        self.confirming = None;
        self.pending_focus = Some(if self.invite.read(cx).text().is_empty() {
            Focus::Invite
        } else {
            Focus::Name
        });
        cx.notify();
    }

    fn cancel_adding(&mut self, cx: &mut Context<Self>) {
        if self.model.read(cx).sender_state.sessions.is_empty() {
            return;
        }
        self.adding = false;
        self.pair_error = None;
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
        match self.senders(cx).send(session.id(), &draft) {
            Ok(()) => {
                self.composer.update(cx, |field, cx| field.clear(cx));
                self.drafts.remove(session.id());
                self.send_error = None;
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

    // Pairing

    fn pair(&mut self, cx: &mut Context<Self>) {
        let invite = self.invite.read(cx).text().trim().to_string();
        let name = self.name.read(cx).text().trim().to_string();
        if invite.is_empty() || name.is_empty() || self.pairing {
            return;
        }
        let color = self.color;
        self.pairing = true;
        self.pair_error = None;
        self.run(
            cx,
            move |senders| senders.pair(&invite, &name, color),
            |this, result, cx| {
                this.pairing = false;
                match result {
                    Ok(id) => {
                        this.invite.update(cx, |field, cx| field.clear(cx));
                        this.adding = false;
                        this.select(id, cx);
                    }
                    Err(error) => this.pair_error = Some(error.to_string()),
                }
            },
        );
    }

    fn unpair(&mut self, id: String, cx: &mut Context<Self>) {
        self.senders(cx).unpair(&id);
        self.after_removing(&id, cx);
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
                Focus::Name => &self.name,
            };
            window.focus(&field.focus_handle(cx));
        }
        let state = self.model.read(cx).sender_state.clone();
        let current = self.current(&state);
        let frame = current.as_ref().map(SenderSession::color).unwrap_or(self.color);
        let page: Vec<AnyElement> = match &current {
            Some(session) => self.composer_page(session, &state, cx),
            None => self.pair_page(&state, cx),
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
                .into_any_element(),
        );

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
        let buttons = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .child(
                pill("unpair", &format!("Unpair {recipient}"), None, None, false).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.action_error = None;
                        this.confirming = Some(Confirm::Unpair);
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
            Some(Confirm::Unpair) => Some(self.confirmation(
                &format!("Stop tapping {recipient}?"),
                format!("Your taps stop reaching {recipient}'s devices. To pair again, you'll need a new invite."),
                "Unpair",
                move |this, cx| this.unpair(id.clone(), cx),
                cx,
            )),
            Some(Confirm::DeleteData) => Some(self.confirmation(
                "Delete your data?",
                format!("Removes you and every tap you sent from {recipient}'s inbox, then unpairs this PC."),
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

// Pairing

impl SendView {
    fn pair_page(&mut self, state: &SenderState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let name = self.name.read(cx).text().trim().to_string();
        let ready = !self.invite.read(cx).text().trim().is_empty() && !name.is_empty() && !self.pairing;
        let first = state.sessions.is_empty();
        let mut page: Vec<AnyElement> = Vec::new();
        if let Some(notice) = state.notice.clone() {
            page.push(self.notice(notice, cx));
        }
        page.push(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .font_weight(FontWeight::EXTRA_BOLD)
                        .text_size(px(30.))
                        .line_height(px(32.))
                        .child(if first { "Tap someone" } else { "Add someone" }),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(paper::tone())
                        .child("Paste the invite link they sent you, then choose how your taps look on their screens."),
                )
                .into_any_element(),
        );
        page.push(labeled("Invite link", input(&self.invite, cx)));
        page.push(labeled("Your name", input(&self.name, cx)));

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
        page.push(labeled(
            "Your color",
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(div().flex().gap(px(10.)).child(a).child(b).child(c).child(d))
                .child(div().flex().gap(px(10.)).child(e).child(f).child(g).child(h))
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(paper::tone())
                        .child("Frames your taps on their screen, so they know it's you from across the room."),
                )
                .into_any_element(),
        ));
        page.push(preview(if name.is_empty() { "You" } else { &name }, self.color).into_any_element());
        if let Some(error) = self.pair_error.clone() {
            page.push(danger_text(error).into_any_element());
        }
        page.push(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    pill(
                        "pair",
                        if self.pairing { "Pairing…" } else { "Pair" },
                        None,
                        Some(self.color),
                        !ready,
                    )
                    .w_full()
                    .when(ready, |pill| pill.on_click(cx.listener(|this, _, _, cx| this.pair(cx)))),
                )
                .when(!first, |el| {
                    el.child(
                        pill("cancel-pair", "Cancel", None, None, false)
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

fn danger_text(text: String) -> impl IntoElement {
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

fn labeled(label: &str, content: impl IntoElement) -> AnyElement {
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
fn input(field: &Entity<TextField>, cx: &App) -> AnyElement {
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
fn pill(
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

/// How your taps look on their screen: your name on your color's frame.
fn preview(name: &str, color: PersonColor) -> impl IntoElement {
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
                |_, cx| cx.new(|cx| SendView::new(model, target, cx)),
            )
            .ok();
        if let Some(handle) = handle {
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
        cx.global_mut::<Shell>().send = handle;
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
