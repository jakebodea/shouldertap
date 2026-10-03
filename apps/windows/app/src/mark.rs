#![cfg_attr(not(windows), allow(dead_code))] // The tray draws it, on Windows.

//! The Shouldertap mark's geometry and the knock (docs/design.md, "The mark"
//! and "Motion"), as apps/macos's Mark.swift draws it for the menu bar. The
//! tray icon is drawn from this.

/// Everything the strokes touch, in the SVG's units (y down), including the
/// round caps. Fitting this box keeps the frame in place with or without knocks.
pub const BOUNDS: (f32, f32, f32, f32) = (-2.5, -11.525, 44.025, 46.025);
pub const FRAME_WIDTH: f32 = 5.0;
pub const KNOCK_WIDTH: f32 = 3.75;

/// The shoulder point the knock marks radiate from; they scale around it.
pub const KNOCK_ORIGIN: (f32, f32) = (23.21, 6.79);

pub const KNOCKS: [((f32, f32), (f32, f32)); 3] = [
    ((26.8, -3.08), (29.19, -9.65)),
    ((30.63, -0.63), (35.58, -5.58)),
    ((33.08, 3.2), (39.65, 0.81)),
];

/// The frame: move, then cubic segments and lines, closed.
pub enum Segment {
    Move(f32, f32),
    Line(f32, f32),
    Cubic(f32, f32, f32, f32, f32, f32),
}

pub const FRAME: [Segment; 9] = [
    Segment::Move(4.0, 0.0),
    Segment::Cubic(23.59, 0.0, 30.0, 6.41, 30.0, 27.5),
    Segment::Line(30.0, 28.0),
    Segment::Cubic(30.0, 31.07, 29.07, 32.0, 26.0, 32.0),
    Segment::Line(4.0, 32.0),
    Segment::Cubic(0.93, 32.0, 0.0, 31.07, 0.0, 28.0),
    Segment::Line(0.0, 4.0),
    Segment::Cubic(0.0, 0.93, 0.93, 0.0, 4.0, 0.0),
    Segment::Line(4.0, 0.0),
];

/// One knock mark's state: `scale` around `KNOCK_ORIGIN` and `opacity`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Knock {
    pub scale: f32,
    pub opacity: f32,
}

impl Knock {
    pub const SHOWN: Knock = Knock {
        scale: 1.0,
        opacity: 1.0,
    };
    pub const HIDDEN: Knock = Knock {
        scale: 0.4,
        opacity: 0.0,
    };
}

pub const RESTING: [Knock; 3] = [Knock::SHOWN; 3];

/// Each mark pops in twice over 900ms, staggered 60ms.
pub const KNOCK_DURATION: f32 = 0.9 + 0.06 * 2.0;

/// The marks `elapsed` seconds into a knock.
pub fn knock_states(elapsed: f32) -> [Knock; 3] {
    std::array::from_fn(|index| knock_frame((elapsed - index as f32 * 0.06) / 0.9))
}

// Keyframes: hidden at 0% and 44%, shown at 14–30% and from 58%.
fn knock_frame(t: f32) -> Knock {
    match t {
        t if t < 0.0 => Knock::HIDDEN,
        t if t < 0.14 => pop(t / 0.14),
        t if t < 0.30 => Knock::SHOWN,
        t if t < 0.44 => fade(1.0 - (t - 0.30) / 0.14),
        t if t < 0.58 => pop((t - 0.44) / 0.14),
        _ => Knock::SHOWN,
    }
}

/// Hidden to shown with a little overshoot, like cubic-bezier(.2, .9, .3, 1.2).
fn pop(p: f32) -> Knock {
    let c1 = 1.70158 * 0.6;
    let c3 = c1 + 1.0;
    let eased = 1.0 + c3 * (p - 1.0).powi(3) + c1 * (p - 1.0).powi(2);
    Knock {
        scale: 0.4 + 0.6 * eased,
        opacity: (p * 1.6).min(1.0),
    }
}

fn fade(p: f32) -> Knock {
    Knock {
        scale: 0.4 + 0.6 * p,
        opacity: p,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_knock_starts_hidden_and_ends_shown() {
        assert_eq!(knock_states(0.0)[1], Knock::HIDDEN);
        assert_eq!(knock_states(KNOCK_DURATION), RESTING);
        // Mid-knock, the marks are on their way back in.
        assert!(knock_states(0.45)[0].opacity < 1.0);
    }
}
