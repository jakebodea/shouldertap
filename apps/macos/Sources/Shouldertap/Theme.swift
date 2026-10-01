import AppKit
import ShouldertapCore
import SwiftUI

/// The paper world inside every frame (docs/design.md, "Color").
enum Paper {
  static let paper = Color(hex: 0xf6f5f1)
  static let faint = Color(hex: 0xebe9e3)
  static let line = Color(hex: 0xdedcd5)
  static let tone = Color(hex: 0x6f6e69)
  static let ink = Color(hex: 0x161616)
}

/// Connected: the same green as the web's live dot.
let liveGreen = Color(hex: 0x2f9e5b)

/// Bricolage Grotesque, bundled as static instances in Resources/Fonts and
/// registered through ATSApplicationFontsPath. Referenced by PostScript name.
enum Bricolage {
  /// 500, optical size 24: text and UI on the overlay.
  static func medium(_ size: CGFloat) -> Font { .custom("BricolageGrotesque-Medium", fixedSize: size) }
  /// 700, optical size 36: names, pills, titles.
  static func bold(_ size: CGFloat) -> Font { .custom("BricolageGrotesque-Bold", fixedSize: size) }
  /// 800, optical size 96: the message.
  static let extraBoldName = "BricolageGrotesque-ExtraBold"
}

/// Person colors from packages/domain/src/colors.ts (`PersonColor.swatch`).
extension PersonColor {
  var base: Color { Color(hex: swatch.base) }
  var ink: Color { Color(hex: swatch.ink) }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255)
  }
}

/// Ease-out expo, the overlay's arrival and swap curve (docs/design.md, "Motion").
extension Animation {
  static func easeOutExpo(_ duration: Double) -> Animation {
    .timingCurve(0.16, 1, 0.3, 1, duration: duration)
  }
}

/// "just now", "4m ago", "2h ago", "3d ago".
func ago(_ timestamp: Timestamp, now: Date = .now) -> String {
  let minutes = Int((now.timeIntervalSince1970 * 1000 - timestamp) / 60_000)
  if minutes < 1 { return "just now" }
  if minutes < 60 { return "\(minutes)m ago" }
  let hours = Int((Double(minutes) / 60).rounded())
  return hours < 24 ? "\(hours)h ago" : "\(Int((Double(hours) / 24).rounded()))d ago"
}
