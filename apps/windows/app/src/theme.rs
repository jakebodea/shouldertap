//! The design tokens from docs/design.md, as apps/macos's Theme.swift has them.

use gpui::{Hsla, Rgba, rgb};
use shouldertap_core::{PersonColor, Timestamp};

/// The paper world inside every frame (docs/design.md, "Color").
pub mod paper {
    use super::*;
    pub fn paper() -> Rgba {
        rgb(0xf6f5f1)
    }
    pub fn faint() -> Rgba {
        rgb(0xebe9e3)
    }
    pub fn line() -> Rgba {
        rgb(0xdedcd5)
    }
    pub fn tone() -> Rgba {
        rgb(0x6f6e69)
    }
    pub fn ink() -> Rgba {
        rgb(0x161616)
    }
}

/// Connected: the same green as the web's live dot.
pub fn live_green() -> Rgba {
    rgb(0x2f9e5b)
}

pub fn base(color: PersonColor) -> Rgba {
    rgb(color.swatch().base)
}

pub fn ink(color: PersonColor) -> Rgba {
    rgb(color.swatch().ink)
}

/// Bricolage Grotesque, bundled from apps/macos/Resources/Fonts (static
/// instances: Medium 500 for text, Bold 700 for names and pills, ExtraBold
/// 800 for the message).
pub const BRICOLAGE: &str = "Bricolage Grotesque";

/// The tray menu is a native surface: the system font (Segoe UI) and the
/// system's light or dark colors, with Bricolage only in the title.
#[derive(Clone, Copy)]
pub struct Surface {
    pub dark: bool,
    pub background: Hsla,
    pub card: Hsla,
    pub separator: Hsla,
    pub primary: Hsla,
    pub secondary: Hsla,
    pub tertiary: Hsla,
    pub hover: Hsla,
    /// The filled button: ink on light, paper on dark.
    pub ink: Hsla,
    pub on_ink: Hsla,
    pub danger: Hsla,
    pub warning: Hsla,
}

impl Surface {
    pub fn new(dark: bool) -> Self {
        let hex = |value: u32| -> Hsla { rgb(value).into() };
        if dark {
            Self {
                dark,
                background: hex(0x202020),
                card: hex(0x2c2c2c),
                separator: hex(0x3a3a3a),
                primary: hex(0xf5f5f5),
                secondary: hex(0xb4b4b4),
                tertiary: hex(0x7a7a7a),
                hover: gpui::white().opacity(0.07),
                ink: hex(0xf5f5f7),
                on_ink: hex(0x1d1d1f),
                danger: hex(0xff6b5f),
                warning: hex(0xf2a33a),
            }
        } else {
            Self {
                dark,
                background: hex(0xf6f6f6),
                card: hex(0xffffff),
                separator: hex(0xe1e1e1),
                primary: hex(0x1d1d1f),
                secondary: hex(0x5f5f63),
                tertiary: hex(0xa0a0a4),
                hover: gpui::black().opacity(0.05),
                ink: hex(0x1d1d1f),
                on_ink: hex(0xffffff),
                danger: hex(0xc42b1c),
                warning: hex(0xd9822b),
            }
        }
    }
}

/// "just now", "4m ago", "2h ago", "3d ago".
pub fn ago(timestamp: Timestamp, now: Timestamp) -> String {
    let minutes = ((now - timestamp) / 60_000.0).floor() as i64;
    if minutes < 1 {
        return "just now".into();
    }
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = (minutes as f64 / 60.0).round() as i64;
    if hours < 24 {
        format!("{hours}h ago")
    } else {
        format!("{}d ago", (hours as f64 / 24.0).round() as i64)
    }
}

/// Ease-out expo, the overlay's arrival and swap curve (docs/design.md, "Motion"):
/// cubic-bezier(0.16, 1, 0.3, 1).
pub fn ease_out_expo(t: f32) -> f32 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, t)
}

/// The overlay's exit: cubic-bezier(0.3, 0, 0.2, 1).
pub fn ease_leave(t: f32) -> f32 {
    cubic_bezier(0.3, 0.0, 0.2, 1.0, t)
}

/// Solves a CSS cubic-bezier timing function for progress `t`.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let sample = |a: f32, b: f32, s: f32| {
        let inv = 1.0 - s;
        3.0 * inv * inv * s * a + 3.0 * inv * s * s * b + s * s * s
    };
    // Find s where x(s) = t by bisection; plenty precise for animation.
    let (mut low, mut high) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = (low + high) / 2.0;
        if sample(x1, x2, mid) < t {
            low = mid;
        } else {
            high = mid;
        }
    }
    sample(y1, y2, (low + high) / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ages() {
        let now = 1_000_000_000.0;
        assert_eq!(ago(now - 10_000.0, now), "just now");
        assert_eq!(ago(now - 4.0 * 60_000.0, now), "4m ago");
        assert_eq!(ago(now - 125.0 * 60_000.0, now), "2h ago");
        assert_eq!(ago(now - 3.0 * 86_400_000.0, now), "3d ago");
    }

    #[test]
    fn easing_ends_where_it_should() {
        assert!(ease_out_expo(0.0).abs() < 0.001);
        assert!((ease_out_expo(1.0) - 1.0).abs() < 0.001);
        // Ease-out: most of the way there early on.
        assert!(ease_out_expo(0.3) > 0.8);
    }
}
