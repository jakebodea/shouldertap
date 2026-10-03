//! What the app draws with, compiled in: the Bricolage fonts the Mac app
//! bundles, the mark, and the Hugeicons glyphs (docs/design.md, "Icons") as
//! SVG built from the same path data as apps/macos's Icons.swift.

use std::borrow::Cow;

use gpui::{AssetSource, SharedString};

pub const FONTS: [&[u8]; 3] = [
    include_bytes!("../../../macos/Resources/Fonts/BricolageGrotesque-Medium.ttf"),
    include_bytes!("../../../macos/Resources/Fonts/BricolageGrotesque-Bold.ttf"),
    include_bytes!("../../../macos/Resources/Fonts/BricolageGrotesque-ExtraBold.ttf"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Icon {
    OnIt,
    In10,
    Reply,
    Send,
    Back,
    Invite,
    Mac,
    Pc,
    Phone,
    AddDevice,
    Remove,
    Copy,
    Close,
}

impl Icon {
    pub fn path(self) -> SharedString {
        format!("icons/{self:?}.svg").into()
    }

    /// 24×24 Hugeicons stroke paths; `circle cx cy r` for their circles.
    fn elements(self) -> &'static [&'static str] {
        match self {
            Icon::OnIt => &["M5 14L8.5 17.5L19 6.5"],
            Icon::In10 => &["circle 12 12 10", "M12 8V12L14 14"],
            Icon::Reply => &[
                "M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12Z",
                "M12.1257 12H12.0007M8.125 12H8M16.125 12H16",
            ],
            Icon::Send => &[
                "M21.0477 3.05293C18.8697 0.707363 2.48648 6.4532 2.50001 8.551C2.51535 10.9299 8.89809 11.6617 10.6672 12.1581C11.7311 12.4565 12.016 12.7625 12.2613 13.8781C13.3723 18.9305 13.9301 21.4435 15.2014 21.4996C17.2278 21.5892 23.1733 5.342 21.0477 3.05293Z",
                "M11.4999 12.5L14.9999 9",
            ],
            Icon::Back => &["M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18"],
            Icon::Invite => &[
                "M3 20.5002C3.28417 16.8058 6.3 13.7193 10.0008 13.5379C10.3134 13.5226 10.6446 13.5097 11 13.5L11.995 13.5663C12.6939 13.6129 13.3665 13.7543 14 13.9777",
                "M18 15.5V21.5M21 18.5L15 18.5",
                "circle 11 6.5 4",
            ],
            Icon::Mac | Icon::Pc => &[
                "M14 21H16M14 21C13.1716 21 12.5 20.3284 12.5 19.5V17L12 17M14 21H10M10 21H8M10 21C10.8284 21 11.5 20.3284 11.5 19.5V17L12 17M12 17V21",
                "M16 3H8C5.17157 3 3.75736 3 2.87868 3.87868C2 4.75736 2 6.17157 2 9V11C2 13.8284 2 15.2426 2.87868 16.1213C3.75736 17 5.17157 17 8 17H16C18.8284 17 20.2426 17 21.1213 16.1213C22 15.2426 22 13.8284 22 11V9C22 6.17157 22 4.75736 21.1213 3.87868C20.2426 3 18.8284 3 16 3Z",
            ],
            Icon::Phone => &[
                "M5 9C5 5.70017 5 4.05025 6.02513 3.02513C7.05025 2 8.70017 2 12 2C15.2998 2 16.9497 2 17.9749 3.02513C19 4.05025 19 5.70017 19 9V15C19 18.2998 19 19.9497 17.9749 20.9749C16.9497 22 15.2998 22 12 22C8.70017 22 7.05025 22 6.02513 20.9749C5 19.9497 5 18.2998 5 15V9Z",
                "M11 19H13",
                "M9 2L9.089 2.53402C9.28188 3.69129 9.37832 4.26993 9.77519 4.62204C10.1892 4.98934 10.7761 5 12 5C13.2239 5 13.8108 4.98934 14.2248 4.62204C14.6217 4.26993 14.7181 3.69129 14.911 2.53402L15 2",
            ],
            Icon::AddDevice => &[
                "M9.14339 10.691L9.35031 10.4841C11.329 8.50532 14.5372 8.50532 16.5159 10.4841C18.4947 12.4628 18.4947 15.671 16.5159 17.6497L13.6497 20.5159C11.671 22.4947 8.46279 22.4947 6.48405 20.5159C4.50532 18.5372 4.50532 15.329 6.48405 13.3503L6.9484 12.886",
                "M17.0516 11.114L17.5159 10.6497C19.4947 8.67095 19.4947 5.46279 17.5159 3.48405C15.5372 1.50532 12.329 1.50532 10.3503 3.48405L7.48405 6.35031C5.50532 8.32904 5.50532 11.5372 7.48405 13.5159C9.46279 15.4947 12.671 15.4947 14.6497 13.5159L14.8566 13.309",
            ],
            Icon::Remove => &[
                "M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5",
                "M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5",
                "M9.5 16.5L9.5 10.5",
                "M14.5 16.5L14.5 10.5",
            ],
            Icon::Copy => &[
                "M7.5 14.5C7.5 11.2002 7.5 9.55025 8.52513 8.52513C9.55025 7.5 11.2002 7.5 14.5 7.5C17.7998 7.5 19.4497 7.5 20.4749 8.52513C21.5 9.55025 21.5 11.2002 21.5 14.5C21.5 17.7998 21.5 19.4497 20.4749 20.4749C19.4497 21.5 17.7998 21.5 14.5 21.5C11.2002 21.5 9.55025 21.5 8.52513 20.4749C7.5 19.4497 7.5 17.7998 7.5 14.5Z",
                "M7.5 16.5C6.10355 16.5 5.40533 16.5 4.84402 16.3036C3.83866 15.9518 3.0482 15.1613 2.69641 14.156C2.5 13.5947 2.5 12.8964 2.5 11.5V9.5C2.5 6.20017 2.5 4.55025 3.52513 3.52513C4.55025 2.5 6.20017 2.5 9.5 2.5H11.5C12.8964 2.5 13.5947 2.5 14.156 2.69641C15.1613 3.0482 15.9518 3.83866 16.3036 4.84402C16.5 5.40533 16.5 6.10355 16.5 7.5",
            ],
            Icon::Close => &["M19 5L5 19M5 5L19 19"],
        }
    }

    const ALL: [Icon; 13] = [
        Icon::OnIt,
        Icon::In10,
        Icon::Reply,
        Icon::Send,
        Icon::Back,
        Icon::Invite,
        Icon::Mac,
        Icon::Pc,
        Icon::Phone,
        Icon::AddDevice,
        Icon::Remove,
        Icon::Copy,
        Icon::Close,
    ];

    /// 1.5 stroke at the 24px design size; GPUI tints it with the text color.
    fn svg(self) -> String {
        let shapes: String = self
            .elements()
            .iter()
            .map(|element| match element.strip_prefix("circle ") {
                Some(circle) => {
                    let n: Vec<&str> = circle.split(' ').collect();
                    format!(r#"<circle cx="{}" cy="{}" r="{}"/>"#, n[0], n[1], n[2])
                }
                None => format!(r#"<path d="{element}"/>"#),
            })
            .collect();
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{shapes}</svg>"#
        )
    }
}

/// The mark (docs/design.md, "The mark"), padded to the same box the Mac's
/// `ShouldertapMark.bounds` fits so the frame never shifts.
pub const MARK_PATH: &str = "mark.svg";
const MARK_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2.5 -11.525 44.025 46.025" width="44" height="46" fill="none" stroke="black" stroke-linecap="round" stroke-linejoin="round"><path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/><path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/><path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/><path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/></svg>"#;

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if path == MARK_PATH {
            return Ok(Some(Cow::Borrowed(MARK_SVG.as_bytes())));
        }
        Ok(Icon::ALL
            .into_iter()
            .find(|icon| icon.path() == path)
            .map(|icon| Cow::Owned(icon.svg().into_bytes())))
    }

    fn list(&self, _path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(Icon::ALL.into_iter().map(Icon::path).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_loads() {
        for icon in Icon::ALL {
            let svg = Assets.load(&icon.path()).unwrap().unwrap();
            assert!(std::str::from_utf8(&svg).unwrap().starts_with("<svg"));
        }
        assert!(Assets.load(MARK_PATH).unwrap().is_some());
        assert!(Assets.load("nope.svg").unwrap().is_none());
    }
}
