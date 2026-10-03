//! The notification-area icon, the Windows counterpart of the Mac's menu bar
//! item: the mark drawn for the taskbar's theme, knocking while a tap waits.
//! Its hidden window also hears the system broadcasts the app cares about.

use std::cell::RefCell;
use std::ffi::c_void;

use futures::channel::mpsc::UnboundedSender;
use tiny_skia::{LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateBitmap, CreateDIBSection, DIB_RGB_COLORS, DeleteObject, HBITMAP,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NIM_SETVERSION, NOTIFYICON_VERSION_4,
    NOTIFYICONDATAW, NOTIFYICONIDENTIFIER, Shell_NotifyIconGetRect, Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyMenu, HICON,
    ICONINFO, MF_SEPARATOR, MF_STRING, PostMessageW, RegisterClassW, RegisterWindowMessageW, SM_CXSMICON,
    SetForegroundWindow, TPM_BOTTOMALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenuEx, WINDOW_EX_STYLE, WM_APP,
    WM_CONTEXTMENU, WM_DISPLAYCHANGE, WM_NULL, WM_POWERBROADCAST, WM_SETTINGCHANGE, WM_WTSSESSION_CHANGE, WNDCLASSW,
    WS_EX_TOOLWINDOW, WS_POPUP,
};
use windows::core::{HSTRING, PCWSTR, w};

use super::{WM_APP_QUIT, WM_APP_SHOW, send, taskbar_is_light, window_class};
use crate::config;
use crate::mark::{self, FRAME, KNOCK_ORIGIN, KNOCKS, Knock, Segment};
use crate::platform::{PlatformEvent, TrayAnchor};

const WM_TRAY: u32 = WM_APP + 1;
const NIN_SELECT: u32 = windows::Win32::UI::WindowsAndMessaging::WM_USER;
const NIN_KEYSELECT: u32 = NIN_SELECT + 1;
const WTS_SESSION_UNLOCK: usize = 0x8;
const PBT_APMRESUMESUSPEND: u32 = 0x7;
const PBT_APMRESUMEAUTOMATIC: u32 = 0x12;
const ICON_ID: u32 = 1;

struct State {
    hwnd: HWND,
    knocks: [Knock; 3],
    tooltip: String,
    icon: Option<HICON>,
    taskbar_created: u32,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// A handle to the tray icon; all of it lives on the main thread.
#[derive(Clone)]
pub struct Tray {
    hwnd: HWND,
}

impl Tray {
    pub fn create(events: UnboundedSender<PlatformEvent>) -> Result<Self, String> {
        super::set_events(events);
        unsafe {
            let instance = GetModuleHandleW(None).map_err(|error| error.to_string())?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: window_class(),
                ..Default::default()
            };
            RegisterClassW(&class);
            // A real (never shown) top-level window, not a message-only one:
            // only top-level windows hear broadcasts like WM_DISPLAYCHANGE.
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
                window_class(),
                &HSTRING::from(config::APP_NAME),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .map_err(|error| error.to_string())?;
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            STATE.with_borrow_mut(|state| {
                *state = Some(State {
                    hwnd,
                    knocks: mark::RESTING,
                    tooltip: config::APP_NAME.into(),
                    icon: None,
                    taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
                })
            });
            add_icon();
            Ok(Self { hwnd })
        }
    }

    pub fn set_knocks(&self, knocks: [Knock; 3]) {
        let changed = STATE.with_borrow_mut(|state| {
            state
                .as_mut()
                .is_some_and(|state| std::mem::replace(&mut state.knocks, knocks) != knocks)
        });
        if changed {
            modify(NIF_ICON);
        }
    }

    pub fn set_tooltip(&self, tooltip: &str) {
        let changed = STATE.with_borrow_mut(|state| {
            state
                .as_mut()
                .is_some_and(|state| std::mem::replace(&mut state.tooltip, tooltip.into()) != tooltip)
        });
        if changed {
            modify(NIF_TIP | NIF_SHOWTIP);
        }
    }

    /// Redraw for the taskbar's (possibly new) theme.
    pub fn refresh_icon(&self) {
        modify(NIF_ICON);
    }

    pub fn anchor(&self) -> Option<TrayAnchor> {
        let identifier = NOTIFYICONIDENTIFIER {
            cbSize: size_of::<NOTIFYICONIDENTIFIER>() as u32,
            hWnd: self.hwnd,
            uID: ICON_ID,
            ..Default::default()
        };
        let rect = unsafe { Shell_NotifyIconGetRect(&identifier) }.ok()?;
        Some(TrayAnchor {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }
}

fn data(state: &State, flags: windows::Win32::UI::Shell::NOTIFY_ICON_DATA_FLAGS) -> NOTIFYICONDATAW {
    let mut data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: state.hwnd,
        uID: ICON_ID,
        uFlags: flags,
        uCallbackMessage: WM_TRAY,
        ..Default::default()
    };
    let tip: Vec<u16> = state.tooltip.encode_utf16().take(data.szTip.len() - 1).collect();
    data.szTip[..tip.len()].copy_from_slice(&tip);
    data
}

/// Adds the icon (again, after Explorer restarts).
fn add_icon() {
    STATE.with_borrow_mut(|state| {
        let Some(state) = state.as_mut() else { return };
        replace_icon(state);
        let mut data = data(state, NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP);
        data.hIcon = state.icon.unwrap_or_default();
        unsafe {
            let _ = Shell_NotifyIconW(NIM_ADD, &data);
            data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            let _ = Shell_NotifyIconW(NIM_SETVERSION, &data);
        }
    });
}

fn modify(flags: windows::Win32::UI::Shell::NOTIFY_ICON_DATA_FLAGS) {
    STATE.with_borrow_mut(|state| {
        let Some(state) = state.as_mut() else { return };
        if flags.contains(NIF_ICON) {
            replace_icon(state);
        }
        let mut data = data(state, flags);
        data.hIcon = state.icon.unwrap_or_default();
        unsafe {
            let _ = Shell_NotifyIconW(NIM_MODIFY, &data);
        }
    });
}

fn replace_icon(state: &mut State) {
    let side = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForWindow(state.hwnd)) }.max(16) as u32;
    // Dev builds draw in orange, so they never pass for the installed app.
    let color = if config::DEV {
        [0xff, 0x95, 0x00]
    } else if taskbar_is_light() {
        [0x1c, 0x1c, 0x1c]
    } else {
        [0xff, 0xff, 0xff]
    };
    let icon = draw_icon(side, color, state.knocks);
    if let Some(old) = std::mem::replace(&mut state.icon, icon) {
        unsafe {
            let _ = DestroyIcon(old);
        }
    }
}

/// The mark as an icon: Mark.swift's `draw(in:color:knocks:)` with tiny-skia.
fn draw_icon(side: u32, color: [u8; 3], knocks: [Knock; 3]) -> Option<HICON> {
    let pixmap = draw_mark(side, color, knocks)?;
    unsafe {
        let header = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: side as i32,
            biHeight: -(side as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let info = BITMAPINFO {
            bmiHeader: header,
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let color_bitmap: HBITMAP = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        // Straight BGRA, as icons want.
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, (side * side * 4) as usize);
        for (index, pixel) in pixmap.pixels().iter().enumerate() {
            let pixel = pixel.demultiply();
            pixels[index * 4..index * 4 + 4].copy_from_slice(&[
                pixel.blue(),
                pixel.green(),
                pixel.red(),
                pixel.alpha(),
            ]);
        }
        let mask = CreateBitmap(side as i32, side as i32, 1, 1, None);
        let icon = CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            hbmMask: mask,
            hbmColor: color_bitmap,
            ..Default::default()
        })
        .ok();
        let _ = DeleteObject(color_bitmap.into());
        let _ = DeleteObject(mask.into());
        icon
    }
}

pub(crate) fn draw_mark(side: u32, color: [u8; 3], knocks: [Knock; 3]) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(side, side)?;
    let (bx, by, bw, bh) = mark::BOUNDS;
    // A hair of inset keeps round caps off the edge.
    let inset = side as f32 * 0.03;
    let scale = ((side as f32 - inset * 2.) / bw).min((side as f32 - inset * 2.) / bh);
    let fit = Transform::from_translate(side as f32 / 2., side as f32 / 2.)
        .pre_scale(scale, scale)
        .pre_translate(-(bx + bw / 2.), -(by + bh / 2.));

    let mut paint = Paint::default();
    paint.set_color_rgba8(color[0], color[1], color[2], 255);
    paint.anti_alias = true;

    let mut frame = PathBuilder::new();
    for segment in &FRAME {
        match *segment {
            Segment::Move(x, y) => frame.move_to(x, y),
            Segment::Line(x, y) => frame.line_to(x, y),
            Segment::Cubic(x1, y1, x2, y2, x, y) => frame.cubic_to(x1, y1, x2, y2, x, y),
        }
    }
    frame.close();
    let stroke = |width: f32| Stroke {
        width,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Default::default()
    };
    pixmap.stroke_path(&frame.finish()?, &paint, &stroke(mark::FRAME_WIDTH), fit, None);

    for ((from, to), state) in KNOCKS.iter().zip(knocks) {
        if state.opacity <= 0.001 {
            continue;
        }
        let mut line = PathBuilder::new();
        line.move_to(from.0, from.1);
        line.line_to(to.0, to.1);
        let around = Transform::from_translate(KNOCK_ORIGIN.0, KNOCK_ORIGIN.1)
            .pre_scale(state.scale, state.scale)
            .pre_translate(-KNOCK_ORIGIN.0, -KNOCK_ORIGIN.1);
        let mut faded = paint.clone();
        faded.set_color_rgba8(color[0], color[1], color[2], (state.opacity * 255.) as u8);
        pixmap.stroke_path(
            &line.finish()?,
            &faded,
            &stroke(mark::KNOCK_WIDTH),
            fit.pre_concat(around),
            None,
        );
    }
    Some(pixmap)
}

/// Open Shouldertap / Quit, on right-click like other tray apps.
fn context_menu(hwnd: HWND, at: POINT) {
    const OPEN: usize = 1;
    const QUIT: usize = 2;
    unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        let _ = AppendMenuW(
            menu,
            MF_STRING,
            OPEN,
            &HSTRING::from(format!("Open {}", config::APP_NAME)),
        );
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(
            menu,
            MF_STRING,
            QUIT,
            &HSTRING::from(format!("Quit {}", config::APP_NAME)),
        );
        // Without this the menu won't close when you click elsewhere.
        let _ = SetForegroundWindow(hwnd);
        let chosen = TrackPopupMenuEx(
            menu,
            (TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN).0,
            at.x,
            at.y,
            hwnd,
            None,
        );
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        match chosen.0 as usize {
            OPEN => send(PlatformEvent::OpenMenu),
            QUIT => send(PlatformEvent::Quit),
            _ => {}
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let taskbar_created = STATE.with_borrow(|state| state.as_ref().map(|state| state.taskbar_created));
    match message {
        WM_TRAY => {
            // NOTIFYICON_VERSION_4: the event in the low word, the anchor point in wParam.
            let at = POINT {
                x: (wparam.0 & 0xffff) as i16 as i32,
                y: ((wparam.0 >> 16) & 0xffff) as i16 as i32,
            };
            match (lparam.0 & 0xffff) as u32 {
                NIN_SELECT | NIN_KEYSELECT => send(PlatformEvent::TrayClicked),
                WM_CONTEXTMENU => context_menu(hwnd, at),
                _ => {}
            }
            LRESULT(0)
        }
        WM_APP_SHOW => {
            send(PlatformEvent::OpenMenu);
            LRESULT(0)
        }
        WM_APP_QUIT => {
            send(PlatformEvent::Quit);
            LRESULT(0)
        }
        WM_POWERBROADCAST => {
            if matches!(wparam.0 as u32, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) {
                send(PlatformEvent::Resumed);
            }
            LRESULT(1)
        }
        WM_WTSSESSION_CHANGE => {
            if wparam.0 == WTS_SESSION_UNLOCK {
                send(PlatformEvent::Resumed);
            }
            LRESULT(0)
        }
        WM_DISPLAYCHANGE => {
            send(PlatformEvent::DisplaysChanged);
            LRESULT(0)
        }
        WM_SETTINGCHANGE => {
            let area = if lparam.0 == 0 {
                String::new()
            } else {
                unsafe { PCWSTR(lparam.0 as *const u16).to_string().unwrap_or_default() }
            };
            if area == "ImmersiveColorSet" {
                send(PlatformEvent::ThemeChanged);
            }
            LRESULT(0)
        }
        _ if Some(message) == taskbar_created && message != 0 => {
            add_icon();
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

impl Drop for State {
    fn drop(&mut self) {
        let data = NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: self.hwnd,
            uID: ICON_ID,
            ..Default::default()
        };
        unsafe {
            let _ = Shell_NotifyIconW(NIM_DELETE, &data);
        }
    }
}

/// Takes the icon out of the tray on quit, so no ghost icon lingers.
pub(crate) fn remove_icon() {
    STATE.with_borrow_mut(|state| state.take());
}
