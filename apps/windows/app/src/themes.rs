//! The tap themes (docs/design.md, "Tap themes"), ported from apps/macos's
//! ThemeViews.swift. Each is its own composition with its own type, layout,
//! answers and arrival; the overlay and the Appearance preview both draw them
//! from a `Scene`. Designs are drawn for a 1440×900 display and multiplied by
//! the scale `u`, so the preview is the real thing at a smaller size.
//!
//! Motion is a pure function of the time since the tap arrived. Words fade in
//! through text highlights over a layout that never changes, so nothing
//! reflows while they arrive; every arrival settles in about a second and
//! nothing loops. GPUI can't rotate or scale an element, so the Mac's tilted
//! note, sideways name and scale punches become level sheets, stacked
//! letters and rises here.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, Entity, Focusable, Font, FontStyle, FontWeight, HighlightStyle, Hsla, MouseButton,
    SharedString, Styled, StyledText, TextRun, Window, canvas, div, fill, point, prelude::*, px, rgb, svg,
};
use shouldertap_core::{ActiveTap, PersonColor, TapTheme, now_ms};

use crate::assets::Icon;
use crate::text_field::TextField;
use crate::theme::{self, BRICOLAGE, paper};

pub const SERIF: &str = "Instrument Serif";
pub const POSTER: &str = "Big Shoulders Display";
pub const TERMINAL: &str = "VT323";
pub const MONO: &str = "Geist Mono";
pub const HAND: &str = "Caveat";

/// What the recipient can do from any theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Act {
    OnIt,
    In10,
    Reply,
    Send,
    Back,
}

pub type Actions = Rc<dyn Fn(Act, &mut Window, &mut App)>;

/// One tap on one surface, as of `elapsed` seconds after it arrived.
pub struct Scene {
    pub theme: TapTheme,
    pub active: ActiveTap,
    pub replying: bool,
    pub reply: Entity<TextField>,
    pub reply_empty: bool,
    pub width: f32,
    pub height: f32,
    pub elapsed: f32,
    pub reduce: bool,
    pub actions: Actions,
    /// The Default Frame keeps the overlay's real pixel sizes (`None`); the
    /// preview scales it like the others.
    pub frame_scale: Option<f32>,
}

/// Whether frames are still needed for the arrival to finish.
pub fn arriving(theme: TapTheme, body: &str, elapsed: f32, reduce: bool) -> bool {
    let settle = if reduce {
        0.2
    } else {
        match theme {
            TapTheme::Default => 0.62,
            TapTheme::Broadsheet => 1.2,
            TapTheme::Billboard => 1.3,
            // Printing, then three cursor blinks; then it stays lit.
            TapTheme::Terminal => print_done(words(body).len()) + 2.8,
            TapTheme::Note => write_done(body) + 0.6,
        }
    };
    elapsed < settle
}

/// The placeholder and caret colors each theme gives the reply field.
pub fn reply_colors(theme: TapTheme, color: PersonColor) -> (Hsla, Hsla) {
    match theme {
        TapTheme::Default => (paper::tone().into(), paper::ink().into()),
        TapTheme::Broadsheet => (hex(0x8a8274), hex(0x1b1813)),
        TapTheme::Billboard => (theme::ink(color).into(), theme::ink(color).into()),
        TapTheme::Terminal => (phosphor(color).opacity(0.45), phosphor(color)),
        TapTheme::Note => (hex(0x9a9fb0), hex(0x1d2742)),
    }
}

pub fn render(scene: &Scene, window: &mut Window, cx: &mut App) -> AnyElement {
    match scene.theme {
        TapTheme::Default => default_frame(scene, window, cx),
        TapTheme::Broadsheet => broadsheet(scene, window, cx),
        TapTheme::Billboard => billboard(scene, window, cx),
        TapTheme::Terminal => terminal(scene, window, cx),
        TapTheme::Note => note(scene, window, cx),
    }
}

// MARK: - Shared

fn hex(value: u32) -> Hsla {
    rgb(value).into()
}

/// `color-mix(in srgb, a share, b)`.
fn mix(a: u32, share: f32, b: u32) -> Hsla {
    let channel = |hex: u32, shift: u32| ((hex >> shift) & 0xff) as f32;
    let mixed = |shift: u32| (channel(a, shift) * share + channel(b, shift) * (1. - share)).round() as u32;
    hex((mixed(16) << 16) | (mixed(8) << 8) | mixed(0))
}

fn phosphor(color: PersonColor) -> Hsla {
    mix(color.swatch().base, 0.38, 0xf1fff3)
}

/// Designs are drawn for 1440×900.
pub fn design_scale(width: f32, height: f32) -> f32 {
    (width / 1440.).min(height / 900.).clamp(0.2, 1.6)
}

fn narrow(width: f32, height: f32) -> bool {
    width < 1100. * design_scale(width, height) || width < height * 1.2
}

/// Progress of a step that starts at `delay` and lasts `duration` seconds.
fn step(scene: &Scene, delay: f32, duration: f32) -> f32 {
    if scene.reduce {
        return 1.;
    }
    ((scene.elapsed - delay) / duration.max(0.001)).clamp(0., 1.)
}

fn ease_out(t: f32) -> f32 {
    theme::cubic_bezier(0.23, 1., 0.32, 1., t)
}

fn ease_in_out(t: f32) -> f32 {
    theme::cubic_bezier(0.77, 0., 0.175, 1., t)
}

/// The whole scene's fade in: the theme's own, or 160ms with reduced motion.
fn root_opacity(scene: &Scene, duration: f32) -> f32 {
    let duration = if scene.reduce { 0.16 } else { duration };
    (scene.elapsed / duration).clamp(0., 1.)
}

/// Spread a stagger over a fixed budget so long messages arrive as fast as short ones.
fn stagger(count: usize, per: f32, budget: f32) -> f32 {
    per.min(budget / (count.max(2) - 1) as f32)
}

/// Byte ranges of the words (runs of non-whitespace).
fn words(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = None;
    for (index, c) in text.char_indices() {
        if c.is_whitespace() {
            if let Some(begin) = start.take() {
                out.push(begin..index);
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(begin) = start {
        out.push(begin..text.len());
    }
    out
}

fn print_done(count: usize) -> f32 {
    0.3 + (count.max(1) - 1) as f32 * stagger(count, 0.055, 0.6)
}

fn write_done(body: &str) -> f32 {
    0.36 + (body.chars().count() as f32 * 0.022).min(0.9)
}

fn font(family: &'static str, weight: FontWeight, italic: bool) -> Font {
    Font {
        weight,
        style: if italic { FontStyle::Italic } else { FontStyle::Normal },
        ..gpui::font(family)
    }
}

/// Text, font family, room and preferred size, weight and style.
type FitKey = (String, String, u32, u32, u32, u32);

thread_local! {
    static FITS: RefCell<HashMap<FitKey, f32>> = RefCell::new(HashMap::new());
}

/// The largest size from `preferred` down to `minimum` (2px steps) at which
/// `text` wraps into `room`, measured by the same text system that draws it.
#[allow(clippy::too_many_arguments)]
fn fit(
    window: &Window,
    text: &str,
    font: Font,
    line: f32,
    width: f32,
    height: f32,
    preferred: f32,
    minimum: f32,
) -> f32 {
    let key = (
        text.to_string(),
        font.family.to_string(),
        width.round() as u32,
        height.round() as u32,
        preferred.round() as u32,
        (font.weight.0 as u32) * 2 + (font.style == FontStyle::Italic) as u32,
    );
    if let Some(size) = FITS.with(|fits| fits.borrow().get(&key).copied()) {
        return size;
    }
    let run = TextRun {
        len: text.len(),
        font,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let mut size = preferred;
    while size > minimum {
        let lines: usize = window
            .text_system()
            .shape_text(
                SharedString::from(text.to_string()),
                px(size),
                std::slice::from_ref(&run),
                Some(px(width)),
                None,
            )
            .map(|lines| lines.iter().map(|l| l.wrap_boundaries.len() + 1).sum())
            .unwrap_or(1);
        if lines as f32 * (size * line).round() <= height {
            break;
        }
        size -= 2.;
    }
    let size = size.max(minimum);
    FITS.with(|fits| {
        let mut fits = fits.borrow_mut();
        if fits.len() > 64 {
            fits.clear();
        }
        fits.insert(key, size);
    });
    size
}

/// The shared design curve: biggest for a few words, smaller for a paragraph.
fn preferred(text: &str, max: f32, min: f32) -> f32 {
    let t = ((text.chars().count() as f32 - 14.) / 70.).clamp(0., 1.);
    (max - (max - min) * t.sqrt()).round()
}

/// The message with each range faded by its amount (1 = not there yet).
fn faded(text: &str, fades: Vec<(Range<usize>, f32)>) -> StyledText {
    StyledText::new(text.to_string()).with_highlights(fades.into_iter().filter(|(_, f)| *f > 0.001).map(
        |(range, fade)| {
            (
                range,
                HighlightStyle {
                    fade_out: Some(fade.clamp(0., 1.)),
                    ..Default::default()
                },
            )
        },
    ))
}

fn border_top<E: Styled>(mut element: E, width: f32, color: Hsla) -> E {
    element.style().border_widths.top = Some(px(width).into());
    element.border_color(color)
}

fn border_bottom<E: Styled>(mut element: E, width: f32) -> E {
    element.style().border_widths.bottom = Some(px(width).into());
    element
}

fn border_left<E: Styled>(mut element: E, width: f32, color: Hsla) -> E {
    element.style().border_widths.left = Some(px(width).into());
    element.border_color(color)
}

fn border_all<E: Styled>(mut element: E, width: f32, color: Hsla) -> E {
    let style = element.style();
    style.border_widths.top = Some(px(width).into());
    style.border_widths.bottom = Some(px(width).into());
    style.border_widths.left = Some(px(width).into());
    style.border_widths.right = Some(px(width).into());
    element.border_color(color)
}

/// A clickable answer; answers come from clicks or the 1/2/3 keys.
fn button(scene: &Scene, id: &'static str, act: Act) -> gpui::Stateful<gpui::Div> {
    let actions = scene.actions.clone();
    let enabled = act != Act::Send || !scene.reply_empty;
    div()
        .id(id)
        .cursor_pointer()
        .when(!enabled, |button| button.opacity(0.4))
        .when(enabled, move |button| {
            button
                .on_click(move |_, window, cx| actions(act, window, cx))
                .active(|style| style.opacity(0.85))
        })
}

/// The reply field, dressed by each theme's wrapper.
fn reply_field(scene: &Scene) -> gpui::Div {
    let focus = scene.reply.clone();
    div()
        .flex_1()
        .min_w_0()
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            window.focus(&focus.focus_handle(cx))
        })
        .child(scene.reply.clone())
}

fn ago(scene: &Scene) -> String {
    theme::ago(scene.active.tap.created_at, now_ms())
}

// MARK: - Default

/// "Frame", the Default theme, exactly as the overlay has always drawn it.
fn default_frame(scene: &Scene, _window: &mut Window, _cx: &mut App) -> AnyElement {
    let u = scene.frame_scale.unwrap_or(1.);
    let tap = &scene.active.tap;
    let color = tap.sender_color;
    // Sized on the display (or, for the preview, a 1440×900 one).
    let (vw, vh) = if scene.frame_scale.is_some() {
        (1440., 900.)
    } else {
        (scene.width, scene.height)
    };
    let message_size = crate::overlay::fit_message(&tap.body, vw, vh) * u;
    let band = div()
        .flex()
        .flex_row()
        .items_baseline()
        .gap(px(18. * u))
        .h(px(96. * u))
        .pt(px(30. * u))
        .px(px(72. * u))
        .text_color(theme::ink(color))
        .font_family(BRICOLAGE)
        .child(
            div()
                .text_size(px(36. * u))
                .font_weight(FontWeight::BOLD)
                .line_height(px(40. * u))
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(tap.sender_name.clone()),
        )
        .child(
            div()
                .text_size(px(20. * u))
                .font_weight(FontWeight::MEDIUM)
                .opacity(0.72)
                .child(ago(scene)),
        )
        .when(scene.active.queued > 0, |band| {
            band.child(
                div()
                    .text_size(px(20. * u))
                    .font_weight(FontWeight::MEDIUM)
                    .opacity(0.85)
                    .child(format!("{} more waiting", scene.active.queued)),
            )
        });
    let swap = theme::ease_out_expo(step(scene, 0., 0.6));
    let rise = if scene.reduce { 0. } else { 18. * u };
    let message = div()
        .flex_1()
        .min_h_0()
        .w_full()
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
                .opacity(swap)
                .mt(px(rise * (1. - swap)))
                .child(tap.body.clone()),
        );
    let controls = if scene.replying {
        let field = div()
            .flex()
            .items_center()
            .flex_1()
            .h(px(68. * u))
            .px(px(30. * u))
            .rounded_full()
            .bg(paper::faint())
            .border_2()
            .border_color(paper::ink())
            .font_family(BRICOLAGE)
            .font_weight(FontWeight::MEDIUM)
            .text_size(px(24. * u))
            .line_height(px(30. * u))
            .text_color(paper::ink())
            .child(reply_field(scene));
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14. * u))
            .child(field)
            .child(pill(
                scene,
                "send",
                Act::Send,
                Icon::Send,
                Some("Send"),
                None,
                Some(color),
                u,
            ))
            .child(pill(scene, "back", Act::Back, Icon::Back, None, None, None, u))
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_row()
            .gap(px(14. * u))
            .child(pill(
                scene,
                "on-it",
                Act::OnIt,
                Icon::OnIt,
                Some("On it"),
                Some("1"),
                Some(color),
                u,
            ))
            .child(pill(
                scene,
                "in-10",
                Act::In10,
                Icon::In10,
                Some("In 10 min"),
                Some("2"),
                None,
                u,
            ))
            .child(pill(
                scene,
                "reply",
                Act::Reply,
                Icon::Reply,
                Some("Reply"),
                Some("3"),
                None,
                u,
            ))
            .into_any_element()
    };
    let page = div()
        .flex()
        .flex_col()
        .flex_1()
        .gap(px(40. * u))
        .py(px(64. * u))
        .px(px(72. * u))
        .mx(px(40. * u))
        .mb(px(40. * u))
        .rounded(px(28. * u))
        .bg(paper::paper())
        .child(message)
        .child(controls);
    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(theme::base(color))
        .opacity(theme::ease_out_expo(root_opacity(scene, 0.52)))
        .child(band)
        .child(page)
        .into_any_element()
}

/// The Frame's rounded answer buttons: 68px tall with a 2px line, or filled
/// in the sender's color for the primary answer.
#[allow(clippy::too_many_arguments)]
fn pill(
    scene: &Scene,
    id: &'static str,
    act: Act,
    icon: Icon,
    label: Option<&'static str>,
    hint: Option<&'static str>,
    fill: Option<PersonColor>,
    u: f32,
) -> gpui::Stateful<gpui::Div> {
    let foreground = fill.map(theme::ink).unwrap_or(paper::ink());
    let pill = button(scene, id, act)
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(12. * u))
        .h(px(68. * u))
        .rounded_full()
        .border_2()
        .text_color(foreground)
        .font_family(BRICOLAGE)
        .child(svg().path(icon.path()).size(px(26. * u)).text_color(foreground));
    let pill = match fill {
        Some(color) => pill.bg(theme::base(color)).border_color(theme::base(color)),
        None => pill
            .border_color(paper::line())
            .hover(|style| style.border_color(paper::ink())),
    };
    let pill = match label {
        Some(label) => pill
            .px(px(28. * u))
            .child(div().text_size(px(24. * u)).font_weight(FontWeight::BOLD).child(label)),
        None => pill.w(px(68. * u)),
    };
    match hint {
        Some(hint) => pill.child(
            div()
                .pl(px(4. * u))
                .text_size(px(15. * u))
                .font_weight(FontWeight::MEDIUM)
                .opacity(0.5)
                .child(hint),
        ),
        None => pill,
    }
}

// MARK: - Broadsheet

/// The tap as a front page: their name as the nameplate over a double rule in
/// their color, the message as the headline, answers in a sidebar.
fn broadsheet(scene: &Scene, window: &mut Window, _cx: &mut App) -> AnyElement {
    let (w, h) = (scene.width, scene.height);
    let u = design_scale(w, h);
    let stacked = narrow(w, h);
    let tap = &scene.active.tap;
    let color = tap.sender_color;
    let base: Hsla = theme::base(color).into();
    let on_base: Hsla = theme::ink(color).into();
    let ink = hex(0x1b1813);
    let ear = hex(0x5b554a);

    let plate_room = if stacked { w - 160. * u } else { w * 0.5 };
    let plate = fit(
        window,
        &tap.sender_name,
        font(SERIF, FontWeight::NORMAL, true),
        0.9,
        plate_room,
        f32::MAX,
        if stacked { 88. } else { 112. } * u,
        48. * u,
    );
    // Tracking settles in: the nameplate fades up from a wider spread.
    let settle = theme::ease_out_expo(step(scene, 0., 0.62));
    let date = chrono_like_date(tap.created_at);
    let waiting = if scene.active.queued > 0 {
        format!("{} · {} more waiting", ago(scene), scene.active.queued)
    } else {
        ago(scene)
    };
    let ear_text = |text: String, end: bool| {
        div()
            .flex_1()
            .min_w_0()
            .when(end, |d| d.flex().justify_end())
            .text_size(px(22. * u))
            .italic()
            .text_color(ear)
            .whitespace_nowrap()
            .overflow_hidden()
            .child(text)
    };
    let mast = div()
        .flex()
        .flex_row()
        .items_end()
        .gap(px(24. * u))
        .pt(px(6. * u))
        .font_family(SERIF)
        .child(ear_text(date, false))
        .child(
            div()
                .text_size(px(plate))
                .line_height(px(plate * 0.9))
                .italic()
                .whitespace_nowrap()
                .opacity(settle)
                .child(tap.sender_name.clone()),
        )
        .child(ear_text(waiting, true));
    let rule = |height: f32, delay: f32| {
        let drawn = ease_in_out(step(scene, delay, 0.64));
        div().h(px(height * u)).w(gpui::relative(drawn)).bg(base)
    };
    let rules = div()
        .flex()
        .flex_col()
        .gap(px(5. * u))
        .mt(px(18. * u))
        .child(rule(7., 0.06))
        .child(rule(2., 0.15));

    let body_font = font(SERIF, FontWeight::NORMAL, false);
    let column_w = if stacked {
        w - 128. * u
    } else {
        w - 128. * u - 48. * u - 330. * u
    };
    let column_h =
        h - 34. * u - 48. * u - plate * 0.9 - 6. * u - 32. * u - 38. * u - if stacked { 260. * u } else { 0. };
    let size = fit(
        window,
        &tap.body,
        body_font,
        0.96,
        column_w,
        column_h,
        preferred(&tap.body, 210. * u, 92. * u),
        40. * u,
    );
    let ranges = words(&tap.body);
    let per = stagger(ranges.len(), 0.034, 0.42);
    let fades = ranges
        .iter()
        .enumerate()
        .map(|(i, r)| (r.clone(), 1. - ease_out(step(scene, 0.18 + i as f32 * per, 0.56))))
        .collect();
    let rise = 1. - ease_out(step(scene, 0.18, 0.7));
    let headline = div().flex_1().min_w_0().min_h_0().overflow_hidden().child(
        div()
            .font_family(SERIF)
            .text_size(px(size))
            .line_height(px((size * 0.96).round()))
            .text_color(ink)
            .mt(px(size * 0.3 * rise))
            .child(faded(&tap.body, fades)),
    );

    let side_in = ease_out(step(scene, 0.38, 0.42));
    let answer = |id: &'static str, act: Act, n: &'static str, label: &'static str, primary: bool, last: bool| {
        let row = button(scene, id, act)
            .flex()
            .flex_row()
            .items_baseline()
            .gap(px(16. * u))
            .pt(px(18. * u))
            .pb(px(16. * u))
            .pl(px(if primary { 14. } else { 4. } * u))
            .pr(px(4. * u))
            .when(primary, |row| row.bg(base).text_color(on_base))
            .when(!primary, |row| row.hover(|style| style.bg(ink.opacity(0.05))))
            .child(
                div()
                    .w(px(18. * u))
                    .italic()
                    .text_size(px(24. * u))
                    .text_color(if primary { on_base.opacity(0.7) } else { hex(0x6d665a) })
                    .child(n),
            )
            .child(div().text_size(px(34. * u)).whitespace_nowrap().child(label));
        let row = border_top(row, 1.5 * u, if primary { base } else { ink });
        if last { border_bottom(row, 1.5 * u) } else { row }
    };
    let side_content = if scene.replying {
        div()
            .flex()
            .flex_col()
            .gap(px(14. * u))
            .child(border_bottom(
                div()
                    .py(px(6. * u))
                    .italic()
                    .text_size(px(34. * u))
                    .line_height(px(42. * u))
                    .text_color(ink)
                    .border_color(ink)
                    .child(reply_field(scene)),
                2. * u,
            ))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(10. * u))
                    .child(border_all(
                        button(scene, "send", Act::Send)
                            .px(px(18. * u))
                            .py(px(10. * u))
                            .text_size(px(28. * u))
                            .bg(base)
                            .text_color(on_base)
                            .child("Send"),
                        1.5 * u,
                        base,
                    ))
                    .child(border_all(
                        button(scene, "back", Act::Back)
                            .px(px(18. * u))
                            .py(px(10. * u))
                            .text_size(px(28. * u))
                            .child("Back"),
                        1.5 * u,
                        ink,
                    )),
            )
    } else {
        div()
            .flex()
            .flex_col()
            .child(answer("on-it", Act::OnIt, "1", "On it", true, false))
            .child(answer("in-10", Act::In10, "2", "In ten minutes", false, false))
            .child(answer("reply", Act::Reply, "3", "Write back", false, true))
    };
    let side = div()
        .flex()
        .flex_col()
        .opacity(side_in)
        .ml(px(14. * u * (1. - side_in)))
        .when(!stacked, |side| side.w(px(330. * u)).pl(px(28. * u)))
        .child(side_content);
    let side = if stacked { side } else { border_left(side, 1.5 * u, ink) };

    let columns = div()
        .flex_1()
        .min_h_0()
        .flex()
        .pt(px(38. * u))
        .gap(px(if stacked { 30. } else { 48. } * u))
        .when(stacked, |c| c.flex_col())
        .when(!stacked, |c| c.flex_row())
        .child(headline)
        .child(side);

    let page = div()
        .size_full()
        .flex()
        .flex_col()
        .pt(px(34. * u))
        .px(px(64. * u))
        .pb(px(48. * u))
        .bg(hex(0xf2ede1))
        .text_color(ink)
        .font_family(SERIF)
        .child(mast)
        .child(rules)
        .child(columns);
    border_all(div().size_full(), 16. * u, base)
        .bg(hex(0xf2ede1))
        .opacity(root_opacity(scene, 0.26))
        .child(page)
        .into_any_element()
}

/// "Tuesday, October 21" in this computer's time zone.
fn chrono_like_date(timestamp: f64) -> String {
    local(timestamp)
        .map(|t| t.format("%A, %B %-d").to_string())
        .unwrap_or_default()
}

/// "2:41 PM" in this computer's time zone.
fn local_time(timestamp: f64) -> String {
    local(timestamp)
        .map(|t| t.format("%-I:%M %p").to_string())
        .unwrap_or_default()
}

fn local(timestamp: f64) -> Option<chrono::DateTime<chrono::Local>> {
    chrono::DateTime::from_timestamp_millis(timestamp as i64).map(|t| t.with_timezone(&chrono::Local))
}

// MARK: - Billboard

/// The whole display becomes a poster in their color: huge condensed
/// capitals, their name down a rail, answers as blocks across the foot.
fn billboard(scene: &Scene, window: &mut Window, _cx: &mut App) -> AnyElement {
    let (w, h) = (scene.width, scene.height);
    let u = design_scale(w, h);
    let stacked = narrow(w, h);
    let tap = &scene.active.tap;
    let color = tap.sender_color;
    let base: Hsla = theme::base(color).into();
    let on_base: Hsla = theme::ink(color).into();
    let rail_w = if stacked { 110. } else { 170. } * u;

    // Their name, a letter per line (GPUI can't turn text sideways).
    let name: Vec<char> = tap
        .sender_name
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let letters = name.len().max(1) as f32;
    let letter = ((h - 240. * u) / (letters * 0.86))
        .min(if stacked { 92. } else { 132. } * u * 0.62)
        .max(20. * u);
    let rail_in = theme::ease_out_expo(step(scene, 0.16, 0.56));
    let rail = border_left(
        div()
            .w(px(rail_w))
            .h_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_between()
            .pt(px(40. * u))
            .pb(px(36. * u))
            .overflow_hidden()
            .font_family(POSTER)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .font_weight(FontWeight::BLACK)
                    .text_size(px(letter))
                    .line_height(px(letter * 0.86))
                    .opacity(rail_in)
                    .mt(px(-letter * 0.4 * (1. - rail_in)))
                    .children(name.iter().map(|c| div().child(c.to_string()))),
            )
            .child(
                div()
                    .font_weight(FontWeight::BOLD)
                    .text_size(px(24. * u))
                    .whitespace_nowrap()
                    .child(ago(scene).to_uppercase()),
            ),
        0.,
        on_base,
    );
    let rail = div()
        .flex()
        .flex_row()
        .h_full()
        .child(rail)
        .child(div().w(px(4. * u)).h_full().bg(on_base));

    let kick_in = step(scene, 0.3, 0.3);
    let kick = div()
        .flex()
        .flex_row()
        .justify_between()
        .font_family(POSTER)
        .font_weight(FontWeight::BOLD)
        .text_size(px(26. * u))
        .opacity(kick_in)
        .child(format!("TAP FROM {}", tap.sender_name.to_uppercase()))
        .when(scene.active.queued > 0, |k| {
            k.child(format!("+{} WAITING", scene.active.queued))
        });
    let upper = tap.body.to_uppercase();
    let strip_h = if stacked { 128. * 3. + 8. } else { 128. } * u;
    let room_w = w - rail_w - 4. * u - 64. * u - 56. * u;
    let room_h = h - strip_h - 4. * u - 44. * u - 40. * u - 34. * u - 24. * u;
    let size = fit(
        window,
        &upper,
        font(POSTER, FontWeight::BLACK, false),
        0.86,
        room_w,
        room_h,
        preferred(&tap.body, 270. * u, 108. * u),
        44. * u,
    );
    let ranges = words(&upper);
    let per = stagger(ranges.len(), 0.07, 0.52);
    let fades = ranges
        .iter()
        .enumerate()
        .map(|(i, r)| {
            (
                r.clone(),
                1. - (step(scene, 0.26 + i as f32 * per, 0.46) / 0.35).min(1.),
            )
        })
        .collect();
    let punch = 1. - ease_out(step(scene, 0.26, 0.46 + per * ranges.len() as f32));
    let message = div()
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .flex()
        .flex_col()
        .justify_end()
        .pt(px(24. * u))
        .child(
            div()
                .font_family(POSTER)
                .font_weight(FontWeight::BLACK)
                .text_size(px(size))
                .line_height(px((size * 0.86).round()))
                .mb(px(-size * 0.28 * punch))
                .child(faded(&upper, fades)),
        );
    let main = div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .pt(px(44. * u))
        .pr(px(64. * u))
        .pb(px(40. * u))
        .pl(px(56. * u))
        .child(kick)
        .child(message);

    let block = |id: &'static str, act: Act, label: &'static str, key: &'static str, primary: bool| {
        button(scene, id, act)
            .flex_1()
            .h(px(128. * u))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(36. * u))
            .font_family(POSTER)
            .font_weight(FontWeight::BLACK)
            .text_size(px(50. * u))
            .when(primary, |b| b.bg(on_base).text_color(base))
            .when(!primary, |b| b.hover(|style| style.bg(on_base.opacity(0.14))))
            .child(div().whitespace_nowrap().child(label))
            .child(
                div()
                    .font_weight(FontWeight::BOLD)
                    .text_size(px(30. * u))
                    .opacity(0.7)
                    .child(key),
            )
    };
    let rule = || {
        if stacked {
            div().h(px(4. * u)).w_full().bg(on_base)
        } else {
            div().w(px(4. * u)).h(px(128. * u)).bg(on_base)
        }
    };
    let strip_in = theme::ease_out_expo(step(scene, 0.32, 0.48));
    let row = if scene.replying {
        div()
            .flex()
            .flex_row()
            .h(px(128. * u))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .px(px(36. * u))
                    .bg(on_base.opacity(0.1))
                    .font_family(POSTER)
                    .font_weight(FontWeight::BOLD)
                    .text_size(px(50. * u))
                    .line_height(px(60. * u))
                    .child(reply_field(scene)),
            )
            .child(div().w(px(4. * u)).h_full().bg(on_base))
            .child(
                button(scene, "send", Act::Send)
                    .w(px(128. * u))
                    .h_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(on_base)
                    .child(svg().path(Icon::Send.path()).size(px(44. * u)).text_color(base)),
            )
            .child(div().w(px(4. * u)).h_full().bg(on_base))
            .child(
                button(scene, "back", Act::Back)
                    .w(px(128. * u))
                    .h_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(svg().path(Icon::Back.path()).size(px(44. * u)).text_color(on_base)),
            )
    } else {
        div()
            .flex()
            .when(stacked, |r| r.flex_col())
            .when(!stacked, |r| r.flex_row())
            .child(block("on-it", Act::OnIt, "ON IT", "1", true))
            .child(rule())
            .child(block("in-10", Act::In10, "IN 10 MIN", "2", false))
            .child(rule())
            .child(block("reply", Act::Reply, "REPLY", "3", false))
    };
    let strip = div()
        .flex()
        .flex_col()
        .mb(px(-strip_h * (1. - strip_in)))
        .child(div().h(px(4. * u)).w_full().bg(on_base))
        .child(row);
    let column = div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .child(main)
        .child(strip);

    // The color wipes across from the left.
    let wipe = if scene.reduce {
        1.
    } else {
        ease_in_out(step(scene, 0., 0.42))
    };
    div()
        .size_full()
        .flex()
        .flex_row()
        .opacity(root_opacity(scene, 0.01))
        .child(
            div()
                .h_full()
                .w(gpui::relative(wipe))
                .overflow_hidden()
                .bg(base)
                .text_color(on_base)
                .child(div().w(px(w)).h_full().flex().flex_row().child(rail).child(column)),
        )
        .into_any_element()
}

// MARK: - Terminal

/// A phosphor console tuned to their color: a status bar in their color, the
/// message as output, a bracketed menu.
fn terminal(scene: &Scene, window: &mut Window, _cx: &mut App) -> AnyElement {
    let (w, h) = (scene.width, scene.height);
    let u = design_scale(w, h);
    let tap = &scene.active.tap;
    let color = tap.sender_color;
    let screen = mix(color.swatch().base, 0.16, 0x060708);
    let glow = phosphor(color);
    let base: Hsla = theme::base(color).into();
    let on_base: Hsla = theme::ink(color).into();

    let bar_in = theme::ease_out_expo(step(scene, 0.12, 0.32));
    let bar = div()
        .h(px(54. * u))
        .mt(px(-54. * u * (1. - bar_in)))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(28. * u))
        .px(px(40. * u))
        .bg(base)
        .text_color(on_base)
        .font_family(MONO)
        .font_weight(FontWeight::MEDIUM)
        .text_size(px(19. * u))
        .whitespace_nowrap()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10. * u))
                .child(div().size(px(11. * u)).rounded_full().bg(on_base))
                .child(div().font_weight(FontWeight::BOLD).child(tap.sender_name.clone())),
        )
        .child("tty/desk")
        .child(div().flex_1())
        .child(ago(scene))
        .when(scene.active.queued > 0, |b| {
            b.child(format!("{} queued", scene.active.queued))
        });

    let handle: String = tap
        .sender_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    // The cursor is a lit cell after the words: a no-break space with a
    // phosphor background, so it sits exactly where the text ends.
    let text = format!("{}\u{00a0}\u{00a0}", tap.body);
    let cursor = tap.body.len() + '\u{00a0}'.len_utf8()..text.len();
    let room_w = w - 144. * u;
    let room_h = h - 54. * u - 48. * u - 52. * u - 64. * u - 78. * u;
    let size = fit(
        window,
        &text,
        font(TERMINAL, FontWeight::NORMAL, false),
        0.98,
        room_w,
        room_h,
        preferred(&tap.body, 168. * u, 84. * u),
        40. * u,
    );
    let ranges = words(&tap.body);
    let per = stagger(ranges.len(), 0.055, 0.6);
    let printed = print_done(ranges.len());
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = ranges
        .iter()
        .enumerate()
        .filter(|(i, _)| !scene.reduce && scene.elapsed < 0.3 + *i as f32 * per)
        .map(|(_, r)| {
            (
                r.clone(),
                HighlightStyle {
                    fade_out: Some(1.),
                    ..Default::default()
                },
            )
        })
        .collect();
    // Blinks three times once printing is done, then stays lit.
    let since = scene.elapsed - printed;
    let lit = scene.reduce || (since >= 0. && (since >= 2.7 || (since % 0.9) < 0.45));
    if lit {
        highlights.push((
            cursor,
            HighlightStyle {
                background_color: Some(glow),
                ..Default::default()
            },
        ));
    }
    let message = div().flex_1().min_h_0().overflow_hidden().child(
        div()
            .font_family(TERMINAL)
            .text_size(px(size))
            .line_height(px((size * 0.98).round()))
            .child(StyledText::new(text).with_highlights(highlights)),
    );
    let option = |id: &'static str, act: Act, key: &'static str, label: &'static str, primary: bool| {
        button(scene, id, act)
            .flex()
            .flex_row()
            .px(px(12. * u))
            .py(px(6. * u))
            .mx(px(-12. * u))
            .whitespace_nowrap()
            .when(primary, |o| o.bg(glow).text_color(screen))
            .when(!primary, |o| o.hover(|style| style.bg(glow).text_color(screen)))
            .child(div().opacity(0.6).child(key))
            .child(format!(" {label}"))
    };
    let menu_in = step(scene, (printed + 0.06).min(0.7), 0.01);
    let foot = if scene.replying {
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(16. * u))
            .child("reply>")
            .child(border_bottom(
                div()
                    .flex_1()
                    .flex()
                    .border_color(glow.opacity(0.45))
                    .child(reply_field(scene)),
                2. * u,
            ))
            .child(option("back", Act::Back, "[esc]", "back", false))
    } else {
        div()
            .flex()
            .flex_row()
            .gap(px(44. * u))
            .child(option("on-it", Act::OnIt, "[1]", "on it", true))
            .child(option("in-10", Act::In10, "[2]", "in 10 min", false))
            .child(option("reply", Act::Reply, "[3]", "reply", false))
    };
    // CRT power-on: a bright line opens to the full screen.
    let open = ease_out(step(scene, 0., 0.3));
    let console = div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .pt(px(48. * u))
        .px(px(72. * u))
        .pb(px(52. * u))
        .font_family(TERMINAL)
        .text_color(glow)
        .child(
            div()
                .text_size(px(38. * u))
                .line_height(px(38. * u))
                .opacity(0.62)
                .mb(px(26. * u))
                .whitespace_nowrap()
                .child(format!(
                    "$ tap --from {}",
                    if handle.is_empty() { "someone" } else { &handle }
                )),
        )
        .child(message)
        .child(
            div()
                .mt(px(30. * u))
                .text_size(px(48. * u))
                .line_height(px(52. * u))
                .opacity(menu_in)
                .child(foot),
        );
    let crt = div().flex_1().min_h_0().flex().flex_col().justify_center().child(
        div()
            .w_full()
            .h(gpui::relative(0.006 + 0.994 * open))
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(div().h(px(h - 54. * u)).flex().flex_col().child(console)),
    );
    let lines = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let mut y = bounds.origin.y;
            while y < bounds.origin.y + bounds.size.height {
                window.paint_quad(fill(
                    gpui::Bounds::new(point(bounds.origin.x, y), gpui::size(bounds.size.width, px(1.))),
                    gpui::black().opacity(0.22),
                ));
                y += px(4.);
            }
        },
    )
    .absolute()
    .size_full();
    div()
        .size_full()
        .relative()
        .flex()
        .flex_col()
        .bg(screen)
        .opacity(root_opacity(scene, 0.12))
        .child(bar)
        .child(crt)
        .child(lines)
        .when(open < 1., |d| {
            d.child(
                div()
                    .absolute()
                    .size_full()
                    .bg(gpui::white().opacity(0.6 * (1. - open))),
            )
        })
        .into_any_element()
}

// MARK: - Note

/// A handwritten note taped to a desk in their color, with tick boxes to
/// answer; a second sheet peeks out when more taps are waiting.
fn note(scene: &Scene, window: &mut Window, _cx: &mut App) -> AnyElement {
    let (w, h) = (scene.width, scene.height);
    let u = design_scale(w, h);
    let stacked = narrow(w, h);
    let tap = &scene.active.tap;
    let color = tap.sender_color;
    let base: Hsla = theme::base(color).into();
    let ink = hex(0x1d2742);
    let highlight = base.opacity(match color {
        PersonColor::Moss => 0.34,
        PersonColor::Cobalt => 0.3,
        PersonColor::Plum => 0.32,
        PersonColor::Tomato => 0.42,
        PersonColor::Ochre => 0.75,
        PersonColor::Rose => 0.95,
        PersonColor::Sky => 0.85,
        PersonColor::Graphite => 0.28,
    });
    let (outer_x, outer_y) = if stacked {
        (30. * u, 40. * u)
    } else {
        (64. * u, 56. * u)
    };
    let sheet_w = (w - 2. * outer_x).min(1100. * u);
    let sheet_h = (h - 2. * outer_y).min(780. * u);
    let (pad_x, pad_top, pad_bottom) = if stacked {
        (48. * u, 56. * u, 40. * u)
    } else {
        (84. * u, 64. * u, 48. * u)
    };

    let room_w = sheet_w - 2. * pad_x;
    let room_h = sheet_h - pad_top - pad_bottom - 40. * u - 14. * u - 72. * u - 36. * u - 60. * u;
    let size = fit(
        window,
        &tap.body,
        font(HAND, FontWeight::BOLD, false),
        1.04,
        room_w,
        room_h,
        preferred(&tap.body, 150. * u, 76. * u),
        40. * u,
    );
    // Written left to right, a character at a time, capped overall.
    let written = write_done(&tap.body);
    let progress = step(scene, 0.36, written - 0.36);
    let shown = (tap.body.len() as f32 * progress).ceil() as usize;
    let cut = (0..=shown.min(tap.body.len()))
        .rev()
        .find(|i| tap.body.is_char_boundary(*i))
        .unwrap_or(0);
    let fades = vec![(cut..tap.body.len(), 1.)];
    let line = (size * 1.04).round();
    let ruled = canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let mut y = bounds.origin.y + px(line + size * 0.1 - 2.);
            while y < bounds.origin.y + bounds.size.height {
                window.paint_quad(fill(
                    gpui::Bounds::new(point(bounds.origin.x, y), gpui::size(bounds.size.width, px(2.))),
                    hex(0x1d2742).opacity(0.13),
                ));
                y += px(line);
            }
        },
    )
    .absolute()
    .size_full();
    let message = div()
        .flex_1()
        .min_h_0()
        .relative()
        .overflow_hidden()
        .mt(px(14. * u))
        .child(ruled)
        .child(
            div()
                .font_family(HAND)
                .font_weight(FontWeight::BOLD)
                .text_size(px(size))
                .line_height(px(line))
                .text_color(ink)
                .child(faded(&tap.body, fades)),
        );
    let sig_in = step(scene, written, 0.26);
    let head = div()
        .flex()
        .flex_row()
        .justify_between()
        .text_size(px(34. * u))
        .line_height(px(40. * u))
        .text_color(hex(0x5a6074))
        .child(local_time(tap.created_at))
        .when(scene.active.queued > 0, |d| {
            d.child(format!("{} more underneath", scene.active.queued))
        });
    let sig = div()
        .flex()
        .justify_end()
        .text_size(px(64. * u))
        .line_height(px(72. * u))
        .whitespace_nowrap()
        .opacity(sig_in)
        .child(format!("— {}", tap.sender_name));
    let tick = |id: &'static str, act: Act, label: &'static str, key: &'static str, marked: bool| {
        button(scene, id, act)
            .group(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14. * u))
            .px(px(6. * u))
            .py(px(4. * u))
            .child(
                div()
                    .size(px(36. * u))
                    .relative()
                    .child(svg().path(Icon::TickBox.path()).size(px(36. * u)).text_color(ink))
                    .child(
                        svg()
                            .path(Icon::TickMark.path())
                            .absolute()
                            .size(px(36. * u))
                            .text_color(ink)
                            .invisible()
                            .group_hover(id, |style| style.visible()),
                    ),
            )
            .child(
                div()
                    .text_size(px(46. * u))
                    .line_height(px(52. * u))
                    .whitespace_nowrap()
                    .px(px(if marked { 6. } else { 0. } * u))
                    .rounded(px(8. * u))
                    .when(marked, |d| d.bg(highlight))
                    .child(label),
            )
            .child(div().text_size(px(26. * u)).text_color(hex(0x7a8094)).child(key))
    };
    let answers = if scene.replying {
        div()
            .flex()
            .flex_row()
            .items_end()
            .gap(px(22. * u))
            .child(border_bottom(
                div()
                    .flex_1()
                    .flex()
                    .px(px(4. * u))
                    .text_size(px(50. * u))
                    .line_height(px(58. * u))
                    .border_color(ink)
                    .child(reply_field(scene)),
                2.5 * u,
            ))
            .child(
                button(scene, "send", Act::Send)
                    .text_size(px(44. * u))
                    .px(px(8. * u))
                    .rounded(px(8. * u))
                    .bg(highlight)
                    .child("Send"),
            )
            .child(button(scene, "back", Act::Back).text_size(px(44. * u)).child("Back"))
    } else {
        div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(40. * u))
            .child(tick("on-it", Act::OnIt, "On it", "1", true))
            .child(tick("in-10", Act::In10, "In 10 min", "2", false))
            .child(tick("reply", Act::Reply, "Reply", "3", false))
    };
    let answers_in = ease_out(step(scene, written.min(0.9), 0.32));
    let foot = border_top(
        div()
            .mt(px(14. * u))
            .pt(px(22. * u))
            .opacity(answers_in)
            .mt(px(14. * u + 8. * u * (1. - answers_in))),
        2. * u,
        ink.opacity(0.18),
    )
    .child(answers);

    let sheet_in = theme::ease_out_expo(step(scene, 0., 0.56));
    let tape_in = ease_out(step(scene, 0.42, 0.18));
    let sheet = div()
        .absolute()
        .top(px(70. * u * (1. - sheet_in)))
        .left_0()
        .w(px(sheet_w))
        .h(px(sheet_h))
        .opacity(sheet_in)
        .rounded(px(6. * u))
        .bg(hex(0xfbf8ee))
        .shadow(vec![
            BoxShadow {
                color: gpui::black().opacity(0.12),
                offset: point(px(0.), px(2. * u)),
                blur_radius: px(4. * u),
                spread_radius: px(0.),
            },
            BoxShadow {
                color: gpui::black().opacity(0.4),
                offset: point(px(0.), px(34. * u)),
                blur_radius: px(60. * u),
                spread_radius: px(-28. * u),
            },
        ])
        .flex()
        .flex_col()
        .pt(px(pad_top))
        .px(px(pad_x))
        .pb(px(pad_bottom))
        .font_family(HAND)
        .font_weight(FontWeight::BOLD)
        .text_color(ink)
        .child(head)
        .child(message)
        .child(sig)
        .child(foot)
        .child(
            div()
                .absolute()
                .top(px(-22. * u))
                .left(px(sheet_w / 2. - 105. * u))
                .w(px(210. * u))
                .h(px(48. * u))
                .bg(mix(color.swatch().base, 0.6, 0xffffff))
                .opacity(0.88 * tape_in),
        );
    let under_in = theme::ease_out_expo(step(scene, 0.06, 0.62));
    let stack = div()
        .relative()
        .w(px(sheet_w))
        .h(px(sheet_h))
        .when(scene.active.queued > 0, |s| {
            s.child(
                div()
                    .absolute()
                    .top(px(14. * u + 90. * u * (1. - under_in)))
                    .left(px(18. * u))
                    .w(px(sheet_w - 12. * u))
                    .h(px(sheet_h))
                    .opacity(under_in)
                    .rounded(px(6. * u))
                    .bg(hex(0xefe9d8))
                    .shadow(vec![BoxShadow {
                        color: gpui::black().opacity(0.35),
                        offset: point(px(0.), px(18. * u)),
                        blur_radius: px(40. * u),
                        spread_radius: px(-22. * u),
                    }]),
            )
        })
        .child(sheet);
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(base)
        .opacity(root_opacity(scene, 0.24))
        .child(stack)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_byte_ranges_that_keep_long_links_whole() {
        let text = "Pls sign: https://a.example/x?y=1 thx";
        let ranges = words(text);
        let found: Vec<&str> = ranges.iter().map(|r| &text[r.clone()]).collect();
        assert_eq!(found, ["Pls", "sign:", "https://a.example/x?y=1", "thx"]);
        assert_eq!(words("  "), Vec::<Range<usize>>::new().as_slice());
    }

    #[test]
    fn arrivals_settle_within_their_budgets_whatever_the_length() {
        let paragraph = "word ".repeat(56);
        // Terminal prints at most 600ms of words, then three 0.9s blinks.
        assert!(!arriving(TapTheme::Terminal, &paragraph, 0.3 + 0.6 + 2.8, false));
        assert!(arriving(TapTheme::Terminal, &paragraph, 1.0, false));
        // Note writes for at most 900ms after it starts.
        assert!(!arriving(TapTheme::Note, &paragraph, 0.36 + 0.9 + 0.6, false));
        // Reduced motion is a short fade for every theme.
        for theme in TapTheme::ALL {
            assert!(!arriving(theme, &paragraph, 0.2, true));
        }
    }

    #[test]
    fn mixes_match_the_mockups_terminal_colors() {
        // Moss phosphor: 38% #1f5a3d into #f1fff3.
        assert_eq!(mix(0x1f5a3d, 0.38, 0xf1fff3), hex(0xa1c0ae));
    }
}
