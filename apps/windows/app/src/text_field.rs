//! A text field: GPUI has no stock one, so this follows its
//! `examples/input.rs`, which goes through the platform input handler (so
//! IME composition and the emoji panel work), plus a length limit,
//! horizontal scrolling, and Enter/Escape events. `multiline` makes it a
//! wrapping text area that scrolls vertically, where Enter starts a new line
//! and Ctrl+Enter submits.

use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, Hsla, KeyBinding, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, ShapedLine, SharedString, Style, TextAlign,
    TextRun, UTF16Selection, UnderlineStyle, Window, WrappedLine, actions, div, fill, point, prelude::*, px, relative,
    size,
};
use unicode_segmentation::UnicodeSegmentation;

actions!(
    text_field,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Cut,
        Copy,
        Submit,
        /// Ctrl+Enter: submits even a multi-line field.
        SubmitAlways,
        Cancel,
    ]
);

const CONTEXT: &str = "TextField";

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some(CONTEXT)),
        KeyBinding::new("delete", Delete, Some(CONTEXT)),
        KeyBinding::new("left", Left, Some(CONTEXT)),
        KeyBinding::new("right", Right, Some(CONTEXT)),
        KeyBinding::new("shift-left", SelectLeft, Some(CONTEXT)),
        KeyBinding::new("shift-right", SelectRight, Some(CONTEXT)),
        KeyBinding::new("home", Home, Some(CONTEXT)),
        KeyBinding::new("end", End, Some(CONTEXT)),
        KeyBinding::new("enter", Submit, Some(CONTEXT)),
        KeyBinding::new("secondary-enter", SubmitAlways, Some(CONTEXT)),
        KeyBinding::new("escape", Cancel, Some(CONTEXT)),
        KeyBinding::new("secondary-a", SelectAll, Some(CONTEXT)),
        KeyBinding::new("secondary-v", Paste, Some(CONTEXT)),
        KeyBinding::new("secondary-c", Copy, Some(CONTEXT)),
        KeyBinding::new("secondary-x", Cut, Some(CONTEXT)),
        KeyBinding::new("shift-insert", Paste, Some(CONTEXT)),
    ]);
}

pub enum TextFieldEvent {
    Changed,
    Submit,
    Cancel,
}

pub struct TextField {
    focus_handle: FocusHandle,
    content: SharedString,
    placeholder: SharedString,
    placeholder_color: Hsla,
    caret_color: Hsla,
    max_length: usize,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    scroll_x: Pixels,
    is_selecting: bool,
    /// Lines tall when multi-line; None for a single line.
    rows: Option<usize>,
    last_lines: Vec<WrappedLine>,
    last_line_height: Pixels,
    scroll_y: Pixels,
}

impl EventEmitter<TextFieldEvent> for TextField {}

impl TextField {
    pub fn new(cx: &mut Context<Self>, placeholder: impl Into<SharedString>, max_length: usize) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: SharedString::default(),
            placeholder: placeholder.into(),
            placeholder_color: gpui::black().opacity(0.4),
            caret_color: gpui::black(),
            max_length,
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            last_layout: None,
            last_bounds: None,
            scroll_x: px(0.),
            is_selecting: false,
            rows: None,
            last_lines: Vec::new(),
            last_line_height: px(0.),
            scroll_y: px(0.),
        }
    }

    /// A wrapping area `rows` lines tall: Enter is a new line, Ctrl+Enter submits.
    pub fn multiline(mut self, rows: usize) -> Self {
        self.rows = Some(rows.max(1));
        self
    }

    pub fn colors(mut self, placeholder: impl Into<Hsla>, caret: impl Into<Hsla>) -> Self {
        self.placeholder_color = placeholder.into();
        self.caret_color = caret.into();
        self
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn set_placeholder(&mut self, placeholder: impl Into<SharedString>) {
        self.placeholder = placeholder.into();
    }

    pub fn set_colors(&mut self, placeholder: impl Into<Hsla>, caret: impl Into<Hsla>) {
        self.placeholder_color = placeholder.into();
        self.caret_color = caret.into();
    }

    /// Replaces the whole text (within the limit), caret at the end.
    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.content = text.chars().take(self.max_length).collect::<String>().into();
        let end = self.content.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        self.marked_range = None;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.content = SharedString::default();
        self.selected_range = 0..0;
        self.selection_reversed = false;
        self.marked_range = None;
        self.scroll_x = px(0.);
        self.scroll_y = px(0.);
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx)
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), cx);
        } else {
            self.move_to(self.selected_range.end, cx)
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx)
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_boundary(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_boundary(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        if self.rows.is_some() {
            self.replace_text_in_range(None, "\n", window, cx);
        } else {
            cx.emit(TextFieldEvent::Submit);
        }
    }

    fn submit_always(&mut self, _: &SubmitAlways, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextFieldEvent::Submit);
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextFieldEvent::Cancel);
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus_handle);
        self.is_selecting = true;
        if event.modifiers.shift {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        } else {
            self.move_to(self.index_for_mouse_position(event.position), cx)
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let line = if self.rows.is_some() {
                text.replace("\r\n", "\n").replace('\r', "\n")
            } else {
                text.replace(['\r', '\n'], " ")
            };
            self.replace_text_in_range(None, &line, window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx)
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        cx.notify()
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.content.is_empty() {
            return 0;
        }
        if self.rows.is_some() {
            return self.area_index_for_position(position);
        }
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref()) else {
            return 0;
        };
        if position.y < bounds.top() {
            return 0;
        }
        if position.y > bounds.bottom() {
            return self.content.len();
        }
        line.closest_index_for_x(position.x - bounds.left() + self.scroll_x)
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset
        } else {
            self.selected_range.end = offset
        };
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify()
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8_offset = 0;
        let mut utf16_count = 0;
        for ch in self.content.chars() {
            if utf16_count >= offset {
                break;
            }
            utf16_count += ch.len_utf16();
            utf8_offset += ch.len_utf8();
        }
        utf8_offset
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16_offset = 0;
        let mut utf8_count = 0;
        for ch in self.content.chars() {
            if utf8_count >= offset {
                break;
            }
            utf8_count += ch.len_utf8();
            utf16_offset += ch.len_utf16();
        }
        utf16_offset
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(idx, _)| (idx < offset).then_some(idx))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(idx, _)| (idx > offset).then_some(idx))
            .unwrap_or(self.content.len())
    }

    /// Where each hard line starts, by byte offset, beside its layout.
    fn area_lines(&self) -> impl Iterator<Item = (usize, &WrappedLine)> {
        let mut start = 0;
        self.last_lines.iter().map(move |line| {
            let line_start = start;
            start += line.len() + 1;
            (line_start, line)
        })
    }

    fn area_index_for_position(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), line_height) = (self.last_bounds.as_ref(), self.last_line_height) else {
            return 0;
        };
        if line_height <= px(0.) {
            return 0;
        }
        let mut y = position.y - bounds.top() + self.scroll_y;
        let x = position.x - bounds.left();
        if y < px(0.) {
            return 0;
        }
        for (start, line) in self.area_lines() {
            let height = line.size(line_height).height;
            if y < height {
                let index = match line.closest_index_for_position(point(x, y), line_height) {
                    Ok(index) | Err(index) => index,
                };
                return start + index.min(line.len());
            }
            y -= height;
        }
        self.content.len()
    }

    /// The caret's spot for `offset`, relative to the area's top-left, unscrolled.
    fn area_position(&self, offset: usize) -> Point<Pixels> {
        let line_height = self.last_line_height;
        let mut top = px(0.);
        for (start, line) in self.area_lines() {
            if offset <= start + line.len() {
                let local = line.position_for_index(offset - start, line_height).unwrap_or_default();
                return point(local.x, top + local.y);
            }
            top += line.size(line_height).height;
        }
        point(px(0.), top)
    }

    /// Replaces `range` with as much of `new_text` as the length limit allows
    /// (counted in characters, like the server).
    fn splice(&mut self, range: &Range<usize>, new_text: &str) -> usize {
        let kept = self.content.chars().count() - self.content[range.clone()].chars().count();
        let room = self.max_length.saturating_sub(kept);
        let inserted: String = new_text.chars().take(room).collect();
        self.content = (self.content[0..range.start].to_owned() + &inserted + &self.content[range.end..]).into();
        inserted.len()
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let inserted = self.splice(&range, new_text);
        self.selected_range = range.start + inserted..range.start + inserted;
        self.marked_range.take();
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let inserted = self.splice(&range, new_text);
        self.marked_range = (inserted > 0).then(|| range.start..range.start + inserted);
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .map(|new_range| new_range.start + range.start..new_range.end + range.start)
            .unwrap_or_else(|| range.start + inserted..range.start + inserted);
        let length = self.content.len();
        self.selected_range = self.selected_range.start.min(length)..self.selected_range.end.min(length);
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let last_layout = self.last_layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        if self.rows.is_some() {
            let start = self.area_position(range.start);
            let origin = point(bounds.left() + start.x, bounds.top() + start.y - self.scroll_y);
            return Some(Bounds::new(origin, size(px(1.), self.last_line_height)));
        }
        let left = bounds.left() - self.scroll_x;
        Some(Bounds::from_corners(
            point(left + last_layout.x_for_index(range.start), bounds.top()),
            point(left + last_layout.x_for_index(range.end), bounds.bottom()),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        if self.rows.is_some() {
            self.last_bounds?.localize(&point)?;
            return Some(self.offset_to_utf16(self.area_index_for_position(point)));
        }
        let line_point = self.last_bounds?.localize(&point)?;
        let last_layout = self.last_layout.as_ref()?;
        let utf8_index = last_layout.index_for_x(line_point.x + self.scroll_x)?;
        Some(self.offset_to_utf16(utf8_index))
    }
}

struct TextElement {
    input: Entity<TextField>,
}

struct PrepaintState {
    line: Option<ShapedLine>,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
    scroll_x: Pixels,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let content = input.content.clone();
        let selected_range = input.selected_range.clone();
        let cursor = input.cursor_offset();
        let style = window.text_style();

        let (display_text, text_color) = if content.is_empty() {
            (input.placeholder.clone(), input.placeholder_color)
        } else {
            (content, style.color)
        };

        let run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match input.marked_range.as_ref() {
            Some(marked_range) => vec![
                TextRun {
                    len: marked_range.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked_range.end - marked_range.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display_text.len() - marked_range.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect(),
            None => vec![run],
        };

        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window.text_system().shape_line(display_text, font_size, &runs, None);

        // Keep the caret in view, scrolling the line under it.
        let caret_x = if input.content.is_empty() {
            px(0.)
        } else {
            line.x_for_index(cursor)
        };
        let width = bounds.size.width - px(2.);
        let mut scroll_x = input.scroll_x;
        if caret_x - scroll_x > width {
            scroll_x = caret_x - width;
        } else if caret_x < scroll_x {
            scroll_x = caret_x;
        }
        scroll_x = scroll_x.min((line.width - width).max(px(0.))).max(px(0.));

        let left = bounds.left() - scroll_x;
        let (selection, cursor) = if selected_range.is_empty() || input.content.is_empty() {
            let caret = Bounds::new(point(left + caret_x, bounds.top()), size(px(1.5), bounds.size.height));
            (None, Some(fill(caret, input.caret_color)))
        } else {
            let selection = Bounds::from_corners(
                point(left + line.x_for_index(selected_range.start), bounds.top()),
                point(left + line.x_for_index(selected_range.end), bounds.bottom()),
            );
            (Some(fill(selection, gpui::rgba(0x3a7bd540))), None)
        };
        PrepaintState {
            line: Some(line),
            cursor,
            selection,
            scroll_x,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.input.clone()), cx);
        let line = prepaint.line.take().unwrap();
        let scroll_x = prepaint.scroll_x;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if let Some(selection) = prepaint.selection.take() {
                window.paint_quad(selection)
            }
            let origin = point(bounds.origin.x - scroll_x, bounds.origin.y);
            let _ = line.paint(origin, window.line_height(), window, cx);
            if focus_handle.is_focused(window)
                && let Some(cursor) = prepaint.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        self.input.update(cx, |input, _| {
            input.last_layout = Some(line);
            input.last_bounds = Some(bounds);
            input.scroll_x = scroll_x;
        });
    }
}

/// The multi-line field: wrapped lines, scrolled to keep the caret in view.
struct AreaElement {
    input: Entity<TextField>,
}

struct AreaPrepaint {
    lines: Vec<WrappedLine>,
    line_height: Pixels,
    scroll_y: Pixels,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
}

impl IntoElement for AreaElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for AreaElement {
    type RequestLayoutState = ();
    type PrepaintState = AreaPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let rows = self.input.read(cx).rows.unwrap_or(1);
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = (window.line_height() * rows as f32).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let style = window.text_style();
        let line_height = window.line_height();
        let empty = input.content.is_empty();
        let (text, color) = if empty {
            (input.placeholder.clone(), input.placeholder_color)
        } else {
            (input.content.clone(), style.color)
        };
        let run = TextRun {
            len: text.len(),
            font: style.font(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match input.marked_range.as_ref().filter(|_| !empty) {
            Some(marked) => vec![
                TextRun {
                    len: marked.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked.end - marked.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: text.len() - marked.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect(),
            None => vec![run],
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let lines: Vec<WrappedLine> = window
            .text_system()
            .shape_text(text, font_size, &runs, Some(bounds.size.width - px(2.)), None)
            .map(|lines| lines.into_vec())
            .unwrap_or_default();

        // Measure against these lines (the placeholder's when empty).
        let selected = input.selected_range.clone();
        let cursor_offset = input.cursor_offset();
        let mut scroll_y = input.scroll_y;
        self.input.update(cx, |input, _| {
            input.last_lines = if empty { Vec::new() } else { lines.clone() };
            input.last_line_height = line_height;
        });
        let input = self.input.read(cx);
        let caret = if empty {
            point(px(0.), px(0.))
        } else {
            input.area_position(cursor_offset)
        };
        let total = lines
            .iter()
            .fold(px(0.), |total, line| total + line.size(line_height).height);
        if caret.y + line_height - scroll_y > bounds.size.height {
            scroll_y = caret.y + line_height - bounds.size.height;
        } else if caret.y < scroll_y {
            scroll_y = caret.y;
        }
        scroll_y = scroll_y.min((total - bounds.size.height).max(px(0.))).max(px(0.));

        let origin = point(bounds.left(), bounds.top() - scroll_y);
        let (cursor, selections) = if selected.is_empty() || empty {
            let caret = Bounds::new(origin + caret, size(px(1.5), line_height));
            (Some(fill(caret, input.caret_color)), Vec::new())
        } else {
            let highlight = gpui::rgba(0x3a7bd540);
            let start = input.area_position(selected.start);
            let end = input.area_position(selected.end);
            let width = bounds.size.width;
            let mut quads = Vec::new();
            let mut row = start.y;
            while row <= end.y {
                let left = if row == start.y { start.x } else { px(0.) };
                // A selection running past a line's end shows a sliver there.
                let right = if row == end.y { end.x } else { width };
                let right = if right <= left && row != end.y {
                    left + px(4.)
                } else {
                    right
                };
                if right > left {
                    quads.push(fill(
                        Bounds::from_corners(origin + point(left, row), origin + point(right, row + line_height)),
                        highlight,
                    ));
                }
                row += line_height;
            }
            (None, quads)
        };
        AreaPrepaint {
            lines,
            line_height,
            scroll_y,
            cursor,
            selections,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.input.clone()), cx);
        let line_height = prepaint.line_height;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for selection in prepaint.selections.drain(..) {
                window.paint_quad(selection);
            }
            let mut origin = point(bounds.left(), bounds.top() - prepaint.scroll_y);
            for line in &prepaint.lines {
                let _ = line.paint(origin, line_height, TextAlign::Left, None, window, cx);
                origin.y += line.size(line_height).height;
            }
            if focus_handle.is_focused(window)
                && let Some(cursor) = prepaint.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        let scroll_y = prepaint.scroll_y;
        self.input.update(cx, |input, _| {
            input.last_bounds = Some(bounds);
            input.scroll_y = scroll_y;
        });
    }
}

impl Render for TextField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .w_full()
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::submit_always))
            .on_action(cx.listener(Self::cancel))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .map(|el| match self.rows {
                Some(_) => el.child(AreaElement { input: cx.entity() }),
                None => el.child(TextElement { input: cx.entity() }),
            })
    }
}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
