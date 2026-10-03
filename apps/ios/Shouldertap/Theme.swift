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

/// The sender's own color frames the screen. Inside it, a `FrameBar` on the
/// frame's top edge carries navigation in the color's ink, and the app lives
/// on the paper page below it (`onPaper()`). The color floods in from the
/// top-left corner when it changes (docs/design.md, "Motion"); with reduced
/// motion it fades.
struct Frame<Content: View>: View {
  let color: PersonColor
  @ViewBuilder var content: Content

  /// The color underneath while a new one floods in.
  @State private var ground: PersonColor?
  @State private var flood: CGFloat = 1
  @State private var generation = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      (ground ?? color).base.ignoresSafeArea()
      color.base
        .ignoresSafeArea()
        .opacity(reduceMotion ? flood : 1)
        .mask(alignment: .topLeading) {
          GeometryReader { proxy in
            let radius = hypot(proxy.size.width, proxy.size.height)
            Circle()
              .frame(width: radius * 2, height: radius * 2)
              .scaleEffect(reduceMotion ? 1 : flood)
              .position(x: 0, y: 0)
          }
          .ignoresSafeArea()
        }
      content
        .environment(\.frameColor, color)
    }
    .onChange(of: color) { old, _ in
      generation += 1
      let current = generation
      withTransaction(Transaction(animation: nil)) {
        ground = old
        flood = 0
      }
      // Next turn of the run loop, so the reset renders before the flood.
      Task {
        withAnimation(.easeInOut(duration: reduceMotion ? 0.4 : 0.7)) {
          flood = 1
        } completion: {
          if current == generation { ground = nil }
        }
      }
    }
  }
}

extension EnvironmentValues {
  /// The color of the enclosing `Frame`, for things drawn on it.
  @Entry var frameColor: PersonColor = .cobalt
}

/// The paper page inside the frame (9pt sides, 40pt top corners), running
/// down off the bottom edge of the screen.
struct PaperPage: ViewModifier {
  private var page: UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 40, topTrailingRadius: 40, style: .continuous)
  }

  func body(content: Content) -> some View {
    content
      .foregroundStyle(Paper.ink)
      .tint(Paper.ink)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      // The paper runs off the bottom of the screen, under the home indicator
      // and the tab bar; the content stays above them, so actions pinned to
      // the bottom of a page are never covered.
      .mask { page.ignoresSafeArea(.container, edges: .bottom) }
      .background { page.fill(Paper.paper).ignoresSafeArea(.container, edges: .bottom) }
      .padding(.horizontal, 9)
  }
}

/// The band on the frame's top edge, above the page: navigation in the
/// frame color's ink, like the sender name on the Mac overlay's frame.
struct FrameBar<Leading: View, Trailing: View>: View {
  @ViewBuilder var leading: Leading
  @ViewBuilder var trailing: Trailing
  @Environment(\.frameColor) private var color

  var body: some View {
    HStack(spacing: 8) {
      leading
      Spacer(minLength: 8)
      trailing
    }
    .frame(height: 56)
    .padding(.horizontal, 16)
    .foregroundStyle(color.ink)
    .animation(.easeInOut(duration: 0.5), value: color)
  }
}

/// A control on the frame: a quiet ink-tinted pill (a circle when it's just
/// an icon), pressing in slightly.
struct FrameButtonStyle: ButtonStyle {
  var iconOnly = false
  @Environment(\.frameColor) private var color

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Bricolage.bold(15))
      .padding(.horizontal, iconOnly ? 0 : 14)
      .frame(minWidth: 40, minHeight: 40)
      .foregroundStyle(color.ink)
      .background(color.ink.opacity(configuration.isPressed ? 0.24 : 0.13), in: .capsule)
      .contentShape(.capsule)
      .scaleEffect(configuration.isPressed ? 0.94 : 1)
      .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
  }
}

/// Back, on the frame.
struct BackButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        IconView(icon: .back, size: 18)
        Text("Back")
      }
      .padding(.leading, -4)
    }
    .buttonStyle(FrameButtonStyle())
    .accessibilityIdentifier("back-button")
  }
}

/// The mark and the word, on the frame. `knock` pops the knock marks.
struct Wordmark: View {
  var knock = 0

  var body: some View {
    HStack(spacing: 7) {
      MarkView(size: 26, knock: knock)
      Text("Shouldertap")
        .font(Bricolage.extraBold(19))
        .tracking(-0.65)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Shouldertap")
  }
}

/// ease-out-expo, the brand's arrival curve.
extension Animation {
  static func outExpo(_ duration: Double) -> Animation { .timingCurve(0.16, 1, 0.3, 1, duration: duration) }
}

/// Arrive with an 18pt rise out of a blur, `delay` seconds after appearing.
/// Reduced motion keeps only the fade.
struct Arrive: ViewModifier {
  var delay: Double = 0
  @State private var shown = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .opacity(shown ? 1 : 0)
      .offset(y: shown || reduceMotion ? 0 : 18)
      .blur(radius: shown || reduceMotion ? 0 : 6)
      .onAppear {
        withAnimation(.outExpo(0.8).delay(delay)) { shown = true }
      }
  }
}

/// A message swapping in: rises 18pt out of a blur; the old one lifts away.
struct Rise: ViewModifier {
  let offset: CGFloat
  let blur: CGFloat
  let opacity: Double

  func body(content: Content) -> some View {
    content.offset(y: offset).blur(radius: blur).opacity(opacity)
  }
}

extension AnyTransition {
  static var rise: AnyTransition {
    .asymmetric(
      insertion: .modifier(
        active: Rise(offset: 18, blur: 8, opacity: 0), identity: Rise(offset: 0, blur: 0, opacity: 1)),
      removal: .modifier(
        active: Rise(offset: -10, blur: 8, opacity: 0), identity: Rise(offset: 0, blur: 0, opacity: 1)))
  }
}

/// Moving between screens: the next one slides in out of a blur, the last
/// one slides away into one. Reduced motion crossfades.
struct Slide: ViewModifier {
  let x: CGFloat
  let blur: CGFloat
  let opacity: Double

  func body(content: Content) -> some View {
    content.offset(x: x).blur(radius: blur).opacity(opacity)
  }
}

extension AnyTransition {
  static func step(forward: Bool) -> AnyTransition {
    let distance: CGFloat = 56
    let rest = Slide(x: 0, blur: 0, opacity: 1)
    return .asymmetric(
      insertion: .modifier(active: Slide(x: forward ? distance : -distance, blur: 6, opacity: 0), identity: rest),
      removal: .modifier(active: Slide(x: forward ? -distance : distance, blur: 6, opacity: 0), identity: rest))
  }
}

extension View {
  func arrive(after delay: Double = 0) -> some View { modifier(Arrive(delay: delay)) }
  func onPaper() -> some View { modifier(PaperPage()) }
}

/// One screen on the page: a scrolling column, with optional actions pinned
/// to the bottom (they ride up with the keyboard).
struct Page<Content: View, Actions: View>: View {
  @ViewBuilder var content: Content
  @ViewBuilder var actions: Actions

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) { content }
        .padding(.horizontal, 22)
        .padding(.top, 28)
        .padding(.bottom, 24)
        .frame(maxWidth: 560, alignment: .leading)
        .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Paper.paper)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if Actions.self != EmptyView.self {
        VStack(spacing: 6) { actions }
          .padding(.horizontal, 22)
          .padding(.top, 12)
          .padding(.bottom, 8)
          .frame(maxWidth: 560)
          .frame(maxWidth: .infinity)
          .background(Paper.paper)
          // Content scrolling under the actions fades out instead of clipping.
          .background(alignment: .top) {
            LinearGradient(colors: [Paper.paper.opacity(0), Paper.paper], startPoint: .top, endPoint: .bottom)
              .frame(height: 28)
              .offset(y: -28)
              .allowsHitTesting(false)
          }
      }
    }
  }
}

extension Page where Actions == EmptyView {
  init(@ViewBuilder content: () -> Content) {
    self.init(content: content, actions: { EmptyView() })
  }
}

/// Primary pill: the person's color with its ink. Secondary: a line outline.
struct PillStyle: ButtonStyle {
  var color: PersonColor?
  var small = false
  /// On the frame itself: an ink pill with the color as its text.
  var inverted = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Bricolage.bold(small ? 15 : 17))
      .padding(.horizontal, small ? 14 : 20)
      .frame(minHeight: small ? 36 : 52)
      .frame(maxWidth: small ? nil : .infinity)
      .foregroundStyle(inverted ? (color?.base ?? Paper.paper) : (color?.ink ?? Paper.ink))
      .background {
        if let color, inverted {
          Capsule().fill(color.ink)
        } else if let color {
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

/// A quiet text action under a primary pill: ink, no fill, full tap height.
struct QuietStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Bricolage.bold(15))
      .foregroundStyle(Paper.ink)
      .frame(maxWidth: .infinity, minHeight: 44)
      .contentShape(Rectangle())
      .opacity(isEnabled ? (configuration.isPressed ? 0.5 : 1) : 0.45)
  }
}

/// A person: a circle in their color with the initial in its ink.
struct Avatar: View {
  let name: String
  let color: PersonColor
  var size: CGFloat = 40

  var body: some View {
    Circle()
      .fill(color.base)
      .overlay {
        Text(name.first.map { String($0).uppercased() } ?? "")
          .font(Bricolage.bold(size * 0.45))
          .foregroundStyle(color.ink)
      }
      .frame(width: size, height: size)
      .accessibilityHidden(true)
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
