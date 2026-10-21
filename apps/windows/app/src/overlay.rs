//! The overlay (docs/design.md, "Surfaces"): one borderless window per
//! display, above everything including full-screen apps, in the sender's
//! color around a calm paper page. Every copy answers the same tap; each keeps
//! its own reply state. Ported from apps/macos's Overlay.swift.

use std::time::{Duration, Instant};

use gpui::{
    Animation, AnimationExt, App, Bounds, Context, DisplayId, Entity, FocusHandle, Focusable, KeyDownEvent, Pixels,
    Render, SharedString, Subscription, Window, WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, div, prelude::*,
};
use shouldertap_core::{ActiveTap, MAX_REPLY_LENGTH, StoreState, TapResponse, TapTheme};

use crate::platform;
use crate::text_field::{TextField, TextFieldEvent};
use crate::theme;
use crate::themes::{self, Act, Actions, Scene};

/// Exit fade; windows close once it has run.
pub const LEAVE: Duration = Duration::from_millis(420);

pub type Respond = std::rc::Rc<dyn Fn(&str, TapResponse, &mut App)>;

pub struct OverlayView {
    active: ActiveTap,
    replying: bool,
    reply: Entity<TextField>,
    focus: FocusHandle,
    respond: Respond,
    /// The recipient's theme and motion, as of when this tap appeared.
    theme: TapTheme,
    reduce_motion: bool,
    /// When the current tap arrived here; its message rises in from then.
    swapped_at: Instant,
    leaving_at: Option<Instant>,
    _subscriptions: Vec<Subscription>,
}

impl OverlayView {
    pub fn new(active: ActiveTap, look: Look, respond: Respond, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (placeholder, caret) = themes::reply_colors(look.theme, active.tap.sender_color);
        let reply = cx.new(|cx| {
            TextField::new(cx, reply_placeholder(look.theme, &active), MAX_REPLY_LENGTH).colors(placeholder, caret)
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
            theme: look.theme,
            reduce_motion: look.reduce_motion,
            swapped_at: Instant::now(),
            leaving_at: None,
            _subscriptions: vec![subscription],
        }
    }

    /// A newer state of the same tap (or the next tap in line).
    pub fn update_active(&mut self, active: ActiveTap, look: Look, window: &mut Window, cx: &mut Context<Self>) {
        if self.active == active {
            return;
        }
        if self.active.tap.id != active.tap.id {
            self.swapped_at = Instant::now();
            // A new tap picks up a theme or motion change made meanwhile.
            self.theme = look.theme;
            self.reduce_motion = look.reduce_motion;
            let (placeholder, caret) = themes::reply_colors(look.theme, active.tap.sender_color);
            self.reply.update(cx, |field, cx| {
                field.clear(cx);
                field.set_placeholder(reply_placeholder(look.theme, &active));
                field.set_colors(placeholder, caret);
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

/// How the recipient's computers show the active tap: in its own sender's
/// theme (or plain, if the recipient chose that), with their motion setting.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub theme: TapTheme,
    pub reduce_motion: bool,
}

impl Look {
    pub fn of(state: &StoreState, active: Option<&ActiveTap>) -> Self {
        Self {
            theme: active.map(|a| state.theme_for(&a.tap)).unwrap_or_default(),
            reduce_motion: state.appearance.reduces_motion(platform::reduce_motion()),
        }
    }
}

pub fn reply_placeholder(theme: TapTheme, active: &ActiveTap) -> SharedString {
    let name = &active.tap.sender_name;
    match theme {
        TapTheme::Default => format!("Reply to {name}"),
        TapTheme::Broadsheet => format!("Write back to {name}…"),
        TapTheme::Billboard => "SAY SOMETHING".into(),
        TapTheme::Terminal => "type, then Enter".into(),
        TapTheme::Note => "Write back…".into(),
    }
    .into()
}

impl Focusable for OverlayView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for OverlayView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let elapsed = self.swapped_at.elapsed().as_secs_f32();
        let this = cx.entity().downgrade();
        let actions: Actions = std::rc::Rc::new(move |act, window, cx| {
            let _ = this.update(cx, |this, cx| this.act(act, window, cx));
        });
        let scene = Scene {
            theme: self.theme,
            active: self.active.clone(),
            replying: self.replying,
            reply: self.reply.clone(),
            reply_empty: self.reply.read(cx).text().trim().is_empty(),
            width: f32::from(viewport.width),
            height: f32::from(viewport.height),
            elapsed,
            reduce: self.reduce_motion,
            actions,
            frame_scale: None,
        };
        // Frames only while the arrival plays; then the overlay sits still.
        if themes::arriving(self.theme, &self.active.tap.body, elapsed, self.reduce_motion) {
            window.request_animation_frame();
        }
        let root = div()
            .id("overlay")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .size_full()
            .child(themes::render(&scene, window, cx));
        match self.leaving_at {
            Some(_) => {
                let leave = Animation::new(LEAVE).with_easing(theme::ease_leave);
                root.with_animation("leave", leave, |root, delta| root.opacity(1. - delta))
                    .into_any_element()
            }
            None => root.into_any_element(),
        }
    }
}

impl OverlayView {
    fn act(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
        match act {
            Act::OnIt => self.answer(TapResponse::on_it(), cx),
            Act::In10 => self.answer(TapResponse::in_10(), cx),
            Act::Reply => self.set_replying(true, window, cx),
            Act::Send => self.send_reply(cx),
            Act::Back => self.set_replying(false, window, cx),
        }
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
    look: Option<Look>,
}

impl Overlays {
    /// Show, update or hide to match the store. Returns the tap now on screen.
    pub fn update(&mut self, active: Option<ActiveTap>, look: Look, respond: &Respond, cx: &mut App) {
        self.active = active.clone();
        self.look = Some(look);
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
            let _ = handle.update(cx, |view, window, cx| view.update_active(active, look, window, cx));
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
            let look = self.look.unwrap_or(Look {
                theme: TapTheme::Default,
                reduce_motion: platform::reduce_motion(),
            });
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
                move |window, cx| cx.new(|cx| OverlayView::new(active, look, respond, window, cx)),
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
