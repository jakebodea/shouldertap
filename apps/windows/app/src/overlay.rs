//! The overlay (docs/design.md, "Surfaces"): one borderless window per
//! display, above everything including full-screen apps, in the sender's
//! color around a calm paper page. Every copy answers the same tap; each keeps
//! its own reply state. Ported from apps/macos's Overlay.swift.

use std::time::{Duration, Instant};

use gpui::{
    Animation, AnimationExt, App, Bounds, Context, DisplayId, Entity, FocusHandle, Focusable, FontWeight, KeyDownEvent,
    MouseButton, Pixels, Render, SharedString, Subscription, Window, WindowBackgroundAppearance, WindowBounds,
    WindowHandle, WindowKind, WindowOptions, div, prelude::*, px, svg,
};
use shouldertap_core::{ActiveTap, MAX_REPLY_LENGTH, TapResponse, now_ms};

use crate::assets::Icon;
use crate::platform;
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme::{self, BRICOLAGE, paper};

/// Arrival fade (docs/design.md, "Motion").
const ARRIVE: Duration = Duration::from_millis(520);
/// Exit fade; windows close once it has run.
pub const LEAVE: Duration = Duration::from_millis(420);

pub type Respond = std::rc::Rc<dyn Fn(&str, TapResponse, &mut App)>;

pub struct OverlayView {
    active: ActiveTap,
    replying: bool,
    reply: Entity<TextField>,
    focus: FocusHandle,
    respond: Respond,
    reduce_motion: bool,
    /// When the current tap arrived here; its message rises in from then.
    swapped_at: Instant,
    leaving_at: Option<Instant>,
    _subscriptions: Vec<Subscription>,
}

impl OverlayView {
    pub fn new(active: ActiveTap, respond: Respond, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let reply = cx.new(|cx| {
            TextField::new(cx, reply_placeholder(&active), MAX_REPLY_LENGTH).colors(paper::tone(), paper::ink())
        });
        let subscription = cx.subscribe_in(&reply, window, |this, _, event, window, cx| match event {
            TextFieldEvent::Submit => this.send_reply(cx),
            TextFieldEvent::Cancel => this.set_replying(false, window, cx),
            TextFieldEvent::Changed => cx.notify(),
        });
        // "4m ago" stays current.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        let focus = cx.focus_handle();
        window.focus(&focus);
        Self {
            active,
            replying: false,
            reply,
            focus,
            respond,
            reduce_motion: platform::reduce_motion(),
            swapped_at: Instant::now(),
            leaving_at: None,
            _subscriptions: vec![subscription],
        }
    }

    /// A newer state of the same tap (or the next tap in line).
    pub fn update_active(&mut self, active: ActiveTap, window: &mut Window, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        if self.active.tap.id != active.tap.id {
            self.swapped_at = Instant::now();
            self.reply.update(cx, |field, cx| {
                field.clear(cx);
                field.set_placeholder(reply_placeholder(&active));
            });
            if self.replying {
                self.replying = false;
                window.focus(&self.focus);
            }
        }
        self.active = active;
        cx.notify();
    }

    pub fn leave(&mut self, cx: &mut Context<Self>) {
        self.leaving_at = Some(Instant::now());
        cx.notify();
    }

    fn answer(&mut self, response: TapResponse, cx: &mut Context<Self>) {
        if self.leaving_at.is_none() {
            (self.respond)(&self.active.tap.id, response, cx);
        }
    }

    fn send_reply(&mut self, cx: &mut Context<Self>) {
        let text = self.reply.read(cx).text().trim().to_string();
        if !text.is_empty() {
            let text: String = text.chars().take(MAX_REPLY_LENGTH).collect();
            self.answer(TapResponse::text(text), cx);
        }
    }

    fn set_replying(&mut self, replying: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.replying = replying;
        if replying {
            window.focus(&self.reply.focus_handle(cx));
        } else {
            window.focus(&self.focus);
        }
        cx.notify();
    }

    /// 1, 2, 3 answer and Escape leaves reply mode. Answers come from a click
    /// or these keys, never a stray Space or Enter typed as the overlay appeared.
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let modifiers = &event.keystroke.modifiers;
        if modifiers.control || modifiers.alt || modifiers.platform {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" if self.replying => self.set_replying(false, window, cx),
            "1" if !self.replying => self.answer(TapResponse::on_it(), cx),
            "2" if !self.replying => self.answer(TapResponse::in_10(), cx),
            "3" if !self.replying => self.set_replying(true, window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }
}

fn reply_placeholder(active: &ActiveTap) -> SharedString {
    format!("Reply to {}", active.tap.sender_name).into()
}

impl Focusable for OverlayView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for OverlayView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tap = self.active.tap.clone();
        let color = tap.sender_color;
        let viewport = window.viewport_size();
        let message_size = fit_message(&tap.body, f32::from(viewport.width), f32::from(viewport.height));

        let band = div()
            .flex()
            .flex_row()
            .items_baseline()
            .gap(px(18.))
            .h(px(96.))
            .pt(px(30.))
            .px(px(72.))
            .text_color(theme::ink(color))
            .font_family(BRICOLAGE)
            .child(
                div()
                    .text_size(px(36.))
                    .font_weight(FontWeight::BOLD)
                    .line_height(px(40.))
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(tap.sender_name.clone()),
            )
            .child(
                div()
                    .text_size(px(20.))
                    .font_weight(FontWeight::MEDIUM)
                    .opacity(0.72)
                    .child(theme::ago(tap.created_at, now_ms())),
            )
            .when(self.active.queued > 0, |band| {
                band.child(
                    div()
                        .text_size(px(20.))
                        .font_weight(FontWeight::MEDIUM)
                        .opacity(0.85)
                        .child(format!("{} more waiting", self.active.queued)),
                )
            });

        let message = div()
            .id(SharedString::from(format!("message-{}", tap.id)))
            .flex_1()
            .min_h_0()
            .w_full()
            // A column, so the message's width limit (not its text) sets its
            // width and it wraps, centered vertically like the Mac's.
            .flex()
            .flex_col()
            .justify_center()
            .child(
                div()
                    .max_w(px(message_size * 12.))
                    .font_family(BRICOLAGE)
                    .font_weight(FontWeight::EXTRA_BOLD)
                    .text_size(px(message_size))
                    .line_height(px((message_size * 0.98).round()))
                    .text_color(paper::ink())
                    .child(tap.body.clone()),
            );
        let rise = if self.reduce_motion { 0. } else { 18. };
        let swap = Animation::new(Duration::from_millis(600)).with_easing(theme::ease_out_expo);
        let message = message.with_animation(
            SharedString::from(format!("swap-{}", tap.id)),
            swap,
            move |message, delta| message.opacity(delta).mt(px(rise * (1. - delta))),
        );

        let controls = if self.replying {
            self.reply_row(cx).into_any_element()
        } else {
            self.answer_row(cx).into_any_element()
        };

        let page = div()
            .flex()
            .flex_col()
            .flex_1()
            .gap(px(40.))
            .py(px(64.))
            .px(px(72.))
            .mx(px(40.))
            .mb(px(40.))
            .rounded(px(28.))
            .bg(paper::paper())
            .child(message)
            .child(controls);

        let root = div()
            .id("overlay")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .size_full()
            .flex()
            .flex_col()
            .bg(theme::base(color))
            .child(band)
            .child(page);

        let arrive = Animation::new(ARRIVE).with_easing(theme::ease_out_expo);
        match self.leaving_at {
            Some(_) => {
                let leave = Animation::new(LEAVE).with_easing(theme::ease_leave);
                root.with_animation("leave", leave, |root, delta| root.opacity(1. - delta))
                    .into_any_element()
            }
            None => root
                .with_animation("arrive", arrive, |root, delta| root.opacity(delta))
                .into_any_element(),
        }
    }
}

impl OverlayView {
    fn answer_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let color = self.active.tap.sender_color;
        div()
            .flex()
            .flex_row()
            .gap(px(14.))
            .child(
                pill("on-it", Icon::OnIt, Some("On it"), Some("1"), Some(color))
                    .on_click(cx.listener(|this, _, _, cx| this.answer(TapResponse::on_it(), cx))),
            )
            .child(
                pill("in-10", Icon::In10, Some("In 10 min"), Some("2"), None)
                    .on_click(cx.listener(|this, _, _, cx| this.answer(TapResponse::in_10(), cx))),
            )
            .child(
                pill("reply", Icon::Reply, Some("Reply"), Some("3"), None)
                    .on_click(cx.listener(|this, _, window, cx| this.set_replying(true, window, cx))),
            )
    }

    fn reply_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let color = self.active.tap.sender_color;
        let empty = self.reply.read(cx).text().trim().is_empty();
        let field = div()
            .flex()
            .items_center()
            .flex_1()
            .h(px(68.))
            .px(px(30.))
            .rounded_full()
            .bg(paper::faint())
            .border_2()
            .border_color(paper::ink())
            .font_family(BRICOLAGE)
            .font_weight(FontWeight::MEDIUM)
            .text_size(px(24.))
            .line_height(px(30.))
            .text_color(paper::ink())
            .on_mouse_down(MouseButton::Left, {
                let focus = self.reply.focus_handle(cx);
                move |_, window, _| window.focus(&focus)
            })
            .child(self.reply.clone());
        let send = pill("send", Icon::Send, Some("Send"), None, Some(color))
            .when(empty, |pill| pill.opacity(0.4))
            .when(!empty, |pill| {
                pill.on_click(cx.listener(|this, _, _, cx| this.send_reply(cx)))
            });
        let back = pill("back", Icon::Back, None, None, None)
            .on_click(cx.listener(|this, _, window, cx| this.set_replying(false, window, cx)));
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14.))
            .child(field)
            .child(send)
            .child(back)
    }
}

/// The overlay's rounded answer buttons: 68px tall with a 2px line, or filled
/// in the sender's color for the primary answer.
fn pill(
    id: &'static str,
    icon: Icon,
    label: Option<&'static str>,
    hint: Option<&'static str>,
    fill: Option<shouldertap_core::PersonColor>,
) -> gpui::Stateful<gpui::Div> {
    let foreground = fill.map(theme::ink).unwrap_or(paper::ink());
    let pill = div()
        .id(id)
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .h(px(68.))
        .rounded_full()
        .border_2()
        .cursor_pointer()
        .text_color(foreground)
        .font_family(BRICOLAGE)
        .child(svg().path(icon.path()).size(px(26.)).text_color(foreground));
    let pill = match fill {
        Some(color) => pill.bg(theme::base(color)).border_color(theme::base(color)),
        None => pill
            .border_color(paper::line())
            .hover(|style| style.border_color(paper::ink())),
    };
    let pill = match label {
        Some(label) => pill
            .px(px(28.))
            .child(div().text_size(px(24.)).font_weight(FontWeight::BOLD).child(label)),
        None => pill.w(px(68.)),
    };
    let pill = pill.active(|style| style.opacity(0.85));
    match hint {
        Some(hint) => pill.child(
            div()
                .pl(px(4.))
                .text_size(px(15.))
                .font_weight(FontWeight::MEDIUM)
                .opacity(0.5)
                .child(hint),
        ),
        None => pill,
    }
}

/// Message size: 156px for a few words down to 80px for a paragraph (on a
/// 1440×900 display), then smaller still if the text wouldn't fit the page.
pub fn fit_message(body: &str, width: f32, height: f32) -> f32 {
    let count = body.chars().count() as f32;
    let scale = (width / 1440.).min(height / 900.).clamp(0.7, 1.4);
    let t = ((count - 14.) / 70.).clamp(0., 1.);
    let preferred = (156. - 76. * t.sqrt()) * scale;
    // Room for text: the page minus its padding and the reply row.
    let room_width = width - 2. * 40. - 2. * 72.;
    let room_height = height - 96. - 40. - 2. * 64. - 68. - 40.;
    // Roughly 0.55em per character and 1em per line, with slack for wrapping.
    let fits = ((room_width * room_height) / (count.max(1.) * 0.75)).max(0.).sqrt();
    preferred.min(fits).max(36.).round()
}

/// Presents one overlay per display for the store's active tap and tears them
/// all down together.
#[derive(Default)]
pub struct Overlays {
    windows: Vec<(WindowHandle<OverlayView>, DisplayId, Bounds<Pixels>)>,
    /// The tap to show, even when no display is awake to show it on yet.
    active: Option<ActiveTap>,
}

impl Overlays {
    /// Show, update or hide to match the store. Returns the tap now on screen.
    pub fn update(&mut self, active: Option<ActiveTap>, respond: &Respond, cx: &mut App) {
        self.active = active.clone();
        let Some(active) = active else {
            self.hide(cx);
            return;
        };
        if self.windows.is_empty() || !self.matches_displays(cx) {
            self.rebuild(active, respond, cx);
            return;
        }
        for (handle, _, _) in &self.windows {
            let active = active.clone();
            let _ = handle.update(cx, |view, window, cx| view.update_active(active, window, cx));
        }
    }

    /// Displays came, went or woke: rebuild for the ones there are now (a tap
    /// that arrived while they slept shows up now).
    pub fn displays_changed(&mut self, respond: &Respond, cx: &mut App) {
        if let Some(active) = self.active.clone()
            && (self.windows.is_empty() || !self.matches_displays(cx))
        {
            self.rebuild(active, respond, cx);
        }
    }

    fn matches_displays(&self, cx: &App) -> bool {
        let displays = cx.displays();
        displays.len() == self.windows.len()
            && displays
                .iter()
                .zip(&self.windows)
                .all(|(display, (_, id, bounds))| display.id() == *id && display.bounds() == *bounds)
    }

    fn rebuild(&mut self, active: ActiveTap, respond: &Respond, cx: &mut App) {
        self.close_now(cx);
        let displays = cx.displays();
        for display in &displays {
            let bounds = display.bounds();
            let respond = respond.clone();
            let active = active.clone();
            let opened = cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: None,
                    focus: true,
                    show: true,
                    kind: WindowKind::PopUp,
                    is_movable: false,
                    is_resizable: false,
                    is_minimizable: false,
                    display_id: Some(display.id()),
                    window_background: WindowBackgroundAppearance::Transparent,
                    app_id: Some(crate::config::APP_ID.into()),
                    window_min_size: None,
                    window_decorations: None,
                    tabbing_identifier: None,
                },
                move |window, cx| cx.new(|cx| OverlayView::new(active, respond, window, cx)),
            );
            if let Ok(handle) = opened {
                self.windows.push((handle, display.id(), bounds));
            }
        }
        // Keyboard focus goes to the overlay on the display with the pointer.
        let target = self
            .windows
            .iter()
            .position(|(handle, _, _)| {
                handle
                    .update(cx, |_, window, _| platform::window_has_pointer(window))
                    .unwrap_or(false)
            })
            .unwrap_or(0);
        for (index, (handle, _, _)) in self.windows.iter().enumerate() {
            let focus = index == target;
            let _ = handle.update(cx, |_, window, cx| platform::present_overlay(window, focus, cx));
        }
    }

    /// Leave with a 420ms fade. The next tap, if any, builds fresh windows,
    /// so fading ones never block it.
    fn hide(&mut self, cx: &mut App) {
        let leaving: Vec<_> = self.windows.drain(..).map(|(handle, _, _)| handle).collect();
        if leaving.is_empty() {
            return;
        }
        for handle in &leaving {
            let _ = handle.update(cx, |view, _, cx| view.leave(cx));
        }
        cx.spawn(async move |cx| {
            cx.background_executor().timer(LEAVE).await;
            for handle in leaving {
                let _ = handle.update(cx, |_, window, _| window.remove_window());
            }
        })
        .detach();
    }

    fn close_now(&mut self, cx: &mut App) {
        for (handle, _, _) in self.windows.drain(..) {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fit_message;

    #[test]
    fn short_messages_are_big_and_long_ones_shrink() {
        assert_eq!(fit_message("Dinner!", 1440., 900.), 156.);
        let paragraph = "Can you come down and help carry the groceries in from the car? There are a lot of bags.";
        let size = fit_message(paragraph, 1440., 900.);
        assert!((70.0..=82.0).contains(&size), "{size}");
        // Never below 36, however small the display.
        assert_eq!(fit_message(&"word ".repeat(56), 800., 500.), 36.);
    }
}
