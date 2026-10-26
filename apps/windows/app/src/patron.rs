//! Patron themes in the app (docs/design.md, "Tap themes"): the words, the
//! live previews drawn by the real overlay renderers, and the cycle through
//! the four patron themes. Pitched gently, never inside a received tap.

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{AnyElement, App, Context, Entity, Task, Window, div, prelude::*, px};
use shouldertap_core::{ActiveTap, Patron, PersonColor, Tap, TapState, TapTheme, now_ms};

use crate::platform;
use crate::shell::Model;
use crate::text_field::TextField;
use crate::themes::{self, Scene};

/// What every preview says.
pub const SAMPLE: &str = "Dinner's ready.";
/// Each patron theme shows this long before the next arrives.
pub const CYCLE_SECONDS: f32 = 3.2;
/// The welcome's fine print.
pub const WELCOME_PRICE: &str = "$2/month, billed $24 a year, plus tax. You can do this later from Settings.";
/// Under "Become a patron to use …" in the Style sheet.
pub const STYLE_PRICE: &str = "$2/month, billed $24 a year, plus tax. Come back here to switch it on.";
/// What a patron gets, for those who aren't.
pub const PERKS: [&str; 3] = [
    "Broadsheet, Billboard, Terminal and Note, on every tap you send.",
    "To everyone you tap. They never pay to see it.",
    "Helps cover running costs, so sending and answering stay free for everyone.",
];

/// One line under each theme's name.
pub fn subtitle(theme: TapTheme) -> &'static str {
    match theme {
        TapTheme::Default => "The calm Frame. Free",
        TapTheme::Broadsheet => "Your tap as a front page",
        TapTheme::Billboard => "A poster in your color",
        TapTheme::Terminal => "A phosphor console",
        TapTheme::Note => "Handwritten, taped down",
    }
}

/// Which patron theme shows `elapsed` seconds into the cycle, and how long
/// since it arrived.
pub fn cycle(elapsed: f32) -> (TapTheme, f32) {
    let index = (elapsed / CYCLE_SECONDS) as usize % TapTheme::PATRON.len();
    (TapTheme::PATRON[index], elapsed % CYCLE_SECONDS)
}

/// "Renews Oct 23, 2027" or "Ends Oct 23, 2027", when the membership has a date.
pub fn renewal(patron: &Patron) -> Option<String> {
    let date = chrono::DateTime::from_timestamp_millis(patron.paid_until? as i64)?
        .with_timezone(&chrono::Local)
        .format("%b %-d, %Y");
    Some(if patron.renews() {
        format!("Renews {date}")
    } else {
        format!("Ends {date}")
    })
}

/// A tap from `name`, as the people they tap would see it.
pub fn sample(name: &str, color: PersonColor, body: &str) -> ActiveTap {
    ActiveTap {
        tap: Tap {
            id: "patron-preview".into(),
            sender_id: "you".into(),
            sender_name: name.into(),
            sender_color: color,
            body: body.into(),
            created_at: now_ms() - 60_000.,
            state: TapState::Pending,
            displayed_at: None,
            acknowledged_at: None,
            acknowledged_by: None,
            response: None,
            sequence: 0,
            theme: None,
            replies: None,
        },
        queued: 0,
    }
}

/// Calm previews when Windows or the recipient asks for reduced motion.
pub fn reduces_motion(model: &Model) -> bool {
    model.state.appearance.reduces_motion(platform::reduce_motion())
}

/// The real overlay for `theme`, drawn at `width`×`height` (a 1440×900
/// display, scaled). Asks for frames only while the arrival plays.
#[allow(clippy::too_many_arguments)]
pub fn preview(
    theme: TapTheme,
    active: ActiveTap,
    width: f32,
    height: f32,
    elapsed: f32,
    reduce: bool,
    reply: &Entity<TextField>,
    radius: f32,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    if themes::arriving(theme, &active.tap.body, elapsed, reduce) {
        window.request_animation_frame();
    }
    let scene = Scene {
        theme,
        active,
        replying: false,
        reply: reply.clone(),
        reply_empty: true,
        width,
        height,
        elapsed,
        reduce,
        actions: Rc::new(|_, _, _| {}),
        frame_scale: Some(width / 1440.),
    };
    div()
        .flex_none()
        .w(px(width))
        .h(px(height))
        .rounded(px(radius))
        .overflow_hidden()
        .child(themes::render(&scene, window, cx))
        .into_any_element()
}

/// Redraws a view at each step of the cycle; dropped, it stops.
pub fn cycle_ticks<V: 'static>(cx: &mut Context<V>) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            cx.background_executor()
                .timer(Duration::from_secs_f32(CYCLE_SECONDS))
                .await;
            if this.update(cx, |_, cx| cx.notify()).is_err() {
                break;
            }
        }
    })
}

/// A cycle that started at `started`, or the still Broadsheet under reduced motion.
pub fn cycle_at(started: Instant, reduce: bool) -> (TapTheme, f32) {
    if reduce {
        (TapTheme::Broadsheet, CYCLE_SECONDS)
    } else {
        cycle(started.elapsed().as_secs_f32())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cycle_runs_broadsheet_billboard_terminal_note_then_again() {
        assert_eq!(cycle(0.).0, TapTheme::Broadsheet);
        assert_eq!(cycle(3.3).0, TapTheme::Billboard);
        assert_eq!(cycle(6.5).0, TapTheme::Terminal);
        assert_eq!(cycle(9.7).0, TapTheme::Note);
        assert_eq!(cycle(12.9).0, TapTheme::Broadsheet);
        assert!((cycle(4.2).1 - 1.0).abs() < 0.001);
    }

    fn patron(status: &str) -> Patron {
        Patron {
            active: true,
            status: status.into(),
            // Noon UTC: the same date from UTC-11 to UTC+11.
            paid_until: Some(1_824_465_600_000.),
            can_manage: true,
            can_subscribe: false,
            legacy_supporter: false,
        }
    }

    #[test]
    fn memberships_say_when_they_renew_or_end() {
        assert_eq!(renewal(&patron("active")).as_deref(), Some("Renews Oct 25, 2027"));
        assert_eq!(renewal(&patron("ending")).as_deref(), Some("Ends Oct 25, 2027"));
    }
}
