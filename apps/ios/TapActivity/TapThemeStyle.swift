import ShouldertapCore
import SwiftUI

// What the tap themes draw with (docs/design.md, "Tap themes"), shared by the
// app (the takeover, the theme cards) and the Live Activity. Mirrors the
// Mac's ThemeViews.swift; each surface lays them out its own way.

/// The bundled faces, by PostScript name (apps/macos/Resources/Fonts,
/// registered with UIAppFonts in both Info.plists).
enum ThemeFont {
  static let frame = "BricolageGrotesque-ExtraBold"
  static let frameName = "BricolageGrotesque-Bold"
  static let serif = "InstrumentSerif-Regular"
  static let serifItalic = "InstrumentSerif-Italic"
  static let poster = "BigShouldersDisplay-Black"
  static let posterBold = "BigShouldersDisplay-Bold"
  static let terminal = "VT323-Regular"
  static let mono = "GeistMono-Bold"
  static let hand = "CaveatRoman-Bold"

  static func font(_ name: String, _ size: CGFloat) -> Font { .custom(name, fixedSize: size) }
  /// Grows with Dynamic Type from `size` at the default setting.
  static func font(_ name: String, _ size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
    .custom(name, size: size, relativeTo: style)
  }
}

/// The themes' fixed colors; everything else comes from the sender's color.
enum ThemeInk {
  /// Broadsheet's newsprint and type.
  static let newsprint: UInt32 = 0xf2ede1
  static let news: UInt32 = 0x1b1813
  /// Note's cream sheet, its blue-black ink and ruled lines.
  static let sheet: UInt32 = 0xfbf8ee
  static let pen: UInt32 = 0x1d2742
  static let rule: UInt32 = 0xc9d6ea

  /// Terminal's type: pale green tuned toward their color.
  static func phosphor(_ color: PersonColor) -> Color { .mix(color.swatch.base, 0.38, 0xf1fff3) }
  /// Terminal's screen: near black, tinted by their color.
  static func screen(_ color: PersonColor) -> Color { .mix(color.swatch.base, 0.16, 0x060708) }

  /// Note's highlighter strength: light swatches can be bold, dark ones must
  /// stay readable under ink.
  static func highlight(_ color: PersonColor) -> Double {
    switch color {
    case .moss: 0.34
    case .cobalt: 0.3
    case .plum: 0.32
    case .tomato: 0.42
    case .ochre: 0.75
    case .rose: 0.95
    case .sky: 0.85
    case .graphite: 0.28
    }
  }
}

extension Color {
  /// `share` of `a` into `b`, per channel, as the Mac themes mix them.
  static func mix(_ a: UInt32, _ share: Double, _ b: UInt32) -> Color {
    func channel(_ hex: UInt32, _ shift: UInt32) -> Double { Double((hex >> shift) & 0xff) / 255 }
    let mixed = { (shift: UInt32) in channel(a, shift) * share + channel(b, shift) * (1 - share) }
    return Color(.sRGB, red: mixed(16), green: mixed(8), blue: mixed(0))
  }
}

/// Terminal's scanlines: thin dark lines every `pitch` points.
struct Scanlines: View {
  var pitch: CGFloat = 3

  var body: some View {
    Canvas { context, size in
      for y in stride(from: 0, to: size.height, by: pitch) {
        context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: pitch * 0.3)), with: .color(.black.opacity(0.22)))
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// Note's ruled lines, `spacing` apart from `top` down.
struct RuledLines: View {
  var top: CGFloat
  var spacing: CGFloat

  var body: some View {
    Canvas { context, size in
      for y in stride(from: top, to: size.height, by: spacing) {
        context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 0.75)), with: .color(Color.mix(ThemeInk.rule, 1, 0)))
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
