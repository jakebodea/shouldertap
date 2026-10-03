//! QR codes for invite links, drawn as crisp squares (like the Mac's
//! CoreImage QR code scaled without interpolation).

use gpui::{Bounds, IntoElement, ParentElement, Pixels, Styled, canvas, div, fill, point, px, size};
use qrcode::{Color, EcLevel, QrCode};

/// A `side`-sized code for `text`, error correction M, on white with a quiet zone.
pub fn qr_code(text: &str, side: Pixels) -> impl IntoElement {
    let modules = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map(|code| (code.width(), code.to_colors()))
        .ok();
    div()
        .size(side)
        .flex_none()
        .rounded(px(6.))
        .overflow_hidden()
        .bg(gpui::white())
        .child(
            canvas(
                |_, _, _| (),
                move |bounds: Bounds<Pixels>, _, window, _| {
                    let Some((width, colors)) = &modules else { return };
                    // Two modules of quiet zone on each side.
                    let quiet = 2;
                    let cells = *width + quiet * 2;
                    let module = (f32::from(bounds.size.width) / cells as f32).floor().max(1.);
                    let inset = (f32::from(bounds.size.width) - module * *width as f32) / 2.;
                    for (index, color) in colors.iter().enumerate() {
                        if *color != Color::Dark {
                            continue;
                        }
                        let (x, y) = (index % width, index / width);
                        let origin = point(
                            bounds.origin.x + px(inset + x as f32 * module),
                            bounds.origin.y + px(inset + y as f32 * module),
                        );
                        window.paint_quad(fill(Bounds::new(origin, size(px(module), px(module))), gpui::black()));
                    }
                },
            )
            .size_full(),
        )
}
