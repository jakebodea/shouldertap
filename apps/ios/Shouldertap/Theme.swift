import ShouldertapCore
import SwiftUI

// docs/design.md, mirrored from apps/macos/Sources/Shouldertap/Theme.swift.

/// The paper world inside every frame. The frame keeps the person's color;
/// the page follows the system appearance (the web's dark tokens).
enum Paper {
  static let paper = adaptive(light: 0xf6f5f1, dark: 0x18181a)
  static let faint = adaptive(light: 0xebe9e3, dark: 0x232326)
  static let line = adaptive(light: 0xdedcd5, dark: 0x34343a)
  static let tone = adaptive(light: 0x6f6e69, dark: 0x9a9994)
  static let ink = adaptive(light: 0x161616, dark: 0xf1f0ec)

  /// The provider runs wherever UIKit resolves the color, including
  /// SwiftUI's async render thread, so it must not be main-actor isolated.
  private static func adaptive(light: UInt32, dark: UInt32) -> Color {
    Color(UIColor(dynamicProvider: resolver(light: light, dark: dark)))
  }

  nonisolated private static func resolver(light: UInt32, dark: UInt32)
    -> @Sendable (UITraitCollection) -> UIColor
  {
    { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) }
  }
}

/// Connected: the same green as the web's live dot.
let liveGreen = Color(hex: 0x2f9e5b)

/// Bricolage Grotesque, bundled from apps/macos/Resources/Fonts and
/// registered with UIAppFonts. Sizes scale with Dynamic Type.
enum Bricolage {
  static func medium(_ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
    .custom("BricolageGrotesque-Medium", size: size, relativeTo: style)
  }
  static func bold(_ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
    .custom("BricolageGrotesque-Bold", size: size, relativeTo: style)
  }
  static func extraBold(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
    .custom("BricolageGrotesque-ExtraBold", size: size, relativeTo: style)
  }
}

extension PersonColor {
  var base: Color { Color(hex: swatch.base) }
  var ink: Color { Color(hex: swatch.ink) }
  var label: String { swatch.label }
}

extension Color {
  init(hex: UInt32) { self.init(uiColor: UIColor(hex: hex)) }
}

extension UIColor {
  nonisolated convenience init(hex: UInt32) {
    self.init(
      red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
      blue: CGFloat(hex & 0xff) / 255, alpha: 1)
  }
}

/// `relativeTime` from apps/web/src/lib/time.ts.
func relativeTime(_ timestamp: Timestamp, now: Date = .now) -> String {
  let seconds = max(0, Int(((now.timeIntervalSince1970 * 1000 - timestamp) / 1000).rounded()))
  if seconds < 10 { return "just now" }
  if seconds < 60 { return "\(seconds)s ago" }
  let minutes = Int((Double(seconds) / 60).rounded())
  if minutes < 60 { return "\(minutes)m ago" }
  let hours = Int((Double(minutes) / 60).rounded())
  if hours < 24 { return "\(hours)h ago" }
  return Date(timeIntervalSince1970: timestamp / 1000).formatted(.dateTime.month(.abbreviated).day())
}

/// `duration` from apps/web/src/lib/time.ts.
func duration(from: Timestamp, to: Timestamp) -> String {
  let seconds = max(1, Int(((to - from) / 1000).rounded()))
  if seconds < 60 { return "\(seconds)s" }
  let minutes = Int((Double(seconds) / 60).rounded())
  return minutes < 60 ? "\(minutes)m" : "\(Int((Double(minutes) / 60).rounded()))h"
}

// MARK: Components

/// The sender's own color frames the screen; the app lives on the paper page
/// inside it (9pt sides, ~44pt page radius under the status bar), running
/// down off the bottom edge.
struct Frame<Content: View>: View {
  let color: PersonColor
  @ViewBuilder var content: Content

  private var page: UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 40, topTrailingRadius: 40, style: .continuous)
  }

  var body: some View {
    ZStack {
      color.base.ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: 24) { content }
          .padding(.horizontal, 22)
          .padding(.top, 28)
          .padding(.bottom, 24)
          .frame(maxWidth: 560, alignment: .leading)
          .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .foregroundStyle(Paper.ink)
      .background(Paper.paper, in: page)
      .clipShape(page)
      .padding(.horizontal, 9)
      .padding(.top, 9)
      // The page runs off the bottom of the screen; the scroll view still
      // insets its content above the home indicator.
      .ignoresSafeArea(.container, edges: .bottom)
    }
    .animation(.easeInOut(duration: 0.5), value: color)
  }
}

/// Primary pill: the person's color with its ink. Secondary: a line outline.
struct PillStyle: ButtonStyle {
  var color: PersonColor?
  var small = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Bricolage.bold(small ? 15 : 17))
      .padding(.horizontal, small ? 14 : 20)
      .frame(minHeight: small ? 36 : 52)
      .frame(maxWidth: small ? nil : .infinity)
      .foregroundStyle(color?.ink ?? Paper.ink)
      .background {
        if let color {
          Capsule().fill(color.base)
        } else {
          Capsule().strokeBorder(Paper.line, lineWidth: 1.5)
        }
      }
      .contentShape(Capsule())
      .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
  }
}

/// Fields: faint fill, radius 18, 17pt text, no border.
struct FieldBackground: ViewModifier {
  func body(content: Content) -> some View {
    content
      .font(Bricolage.medium(17))
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .background(Paper.faint, in: .rect(cornerRadius: 18, style: .continuous))
  }
}

extension View {
  func field() -> some View { modifier(FieldBackground()) }
}

/// Live / Connecting / Reconnecting, like the web's StatusLabel.
struct StatusLabel: View {
  let status: LiveStatus
  @State private var pulse = false

  var body: some View {
    HStack(spacing: 7) {
      Circle()
        .fill(status == .live ? liveGreen : Paper.tone)
        .frame(width: 8, height: 8)
        .opacity(status == .live ? 1 : (pulse ? 0.35 : 1))
        .animation(status == .live ? .default : .easeInOut(duration: 0.8).repeatForever(), value: pulse)
      Text(label)
    }
    .font(Bricolage.bold(13, relativeTo: .caption))
    .foregroundStyle(Paper.tone)
    .onAppear { pulse = true }
    .accessibilityElement(children: .combine)
  }

  private var label: String {
    switch status {
    case .live: "Live"
    case .connecting: "Connecting"
    case .offline: "Reconnecting"
    }
  }
}
