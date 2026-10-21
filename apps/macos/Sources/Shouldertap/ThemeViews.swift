import AppKit
import ShouldertapCore
import SwiftUI

// The expressive tap themes (docs/design.md, "Tap themes"). Each is its own
// composition: its own type, layout, answer controls and arrival, drawn at a
// 1440×900 design size and scaled to the display. They share only the model
// (the tap, reply state, answering) with the Default Frame in Overlay.swift.
// Words are never letter-split and nothing loops: every arrival settles in
// about a second, and reduced motion is a 160ms fade into the settled screen.

/// The bundled faces, by PostScript name (Resources/Fonts).
enum ThemeFont {
  static let serif = "InstrumentSerif-Regular"
  static let serifItalic = "InstrumentSerif-Italic"
  static let poster = "BigShouldersDisplay-Black"
  static let posterBold = "BigShouldersDisplay-Bold"
  static let terminal = "VT323-Regular"
  static let mono = "GeistMono-Medium"
  static let monoBold = "GeistMono-Bold"
  static let hand = "CaveatRoman-Bold"

  static func font(_ name: String, _ size: CGFloat) -> Font { .custom(name, fixedSize: size) }
}

/// Designs are drawn for a 1440×900 display.
func designScale(_ size: CGSize) -> CGFloat {
  min(1.6, max(0.6, min(size.width / 1440, size.height / 900)))
}

/// Tall or narrow displays stack the answers under the message.
func isNarrow(_ size: CGSize) -> Bool { size.width < 1100 || size.width < size.height * 1.2 }

private let easeOut = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 1)
private let easeInOut = Animation.timingCurve(0.77, 0, 0.175, 1, duration: 1)

extension Animation {
  fileprivate func lasting(_ seconds: Double) -> Animation { speed(1 / seconds) }
}

extension Color {
  /// `color-mix(in srgb, a share, b)`, close enough to the mockup's oklab mix
  /// for these fixed swatches.
  static func mix(_ a: UInt32, _ share: Double, _ b: UInt32) -> Color {
    func channel(_ hex: UInt32, _ shift: UInt32) -> Double { Double((hex >> shift) & 0xff) / 255 }
    let mixed = { (shift: UInt32) in channel(a, shift) * share + channel(b, shift) * (1 - share) }
    return Color(.sRGB, red: mixed(16), green: mixed(8), blue: mixed(0))
  }
}

/// Every theme's answers: clicks only, never focus (so a stray Space or
/// Return typed as the tap appears can't answer); 1, 2, 3 and Escape come
/// from OverlayController's key monitor.
private struct ThemeButton<Label: View>: View {
  let accessibility: String
  let action: () -> Void
  @ViewBuilder var label: (_ hovered: Bool) -> Label
  @State private var hovered = false

  var body: some View {
    Button(action: action) { label(hovered).contentShape(Rectangle()) }
      .buttonStyle(Press())
      .focusable(false)
      .onHover { hovered = $0 }
      .accessibilityLabel(accessibility)
  }

  private struct Press: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
      configuration.label.scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
  }
}

/// The reply field each theme dresses: focused when it appears, Return sends,
/// capped at the reply limit.
private struct ThemeReplyField: View {
  @Bindable var model: OverlayModel
  let placeholder: String
  let font: Font
  let ink: Color
  let hint: Color
  @FocusState private var focused: Bool

  var body: some View {
    TextField("", text: $model.reply, prompt: Text(placeholder).foregroundStyle(hint))
      .textFieldStyle(.plain)
      .font(font)
      .foregroundStyle(ink)
      .focused($focused)
      .onSubmit { model.sendReply() }
      .onChange(of: model.reply) { _, text in
        if text.count > maxReplyLength { model.reply = String(text.prefix(maxReplyLength)) }
      }
      .onAppear { focused = true }
      .accessibilityLabel("Reply to \(model.active.tap.senderName)")
  }
}

/// A view whose unrotated size is swapped, so a sideways label takes the
/// space it appears to.
private struct Sideways: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let size = subviews.first?.sizeThatFits(.unspecified) ?? .zero
    return CGSize(width: size.height, height: size.width)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: .unspecified)
  }
}

/// The widest `name` set in `font` can be at most `room` long.
@MainActor
private func fitLine(_ text: String, font: String, preferred: CGFloat, minimum: CGFloat, room: CGFloat) -> CGFloat {
  guard let unit = NSFont(name: font, size: 100) else { return preferred }
  let width = (text as NSString).size(withAttributes: [.font: unit]).width / 100
  guard width > 0 else { return preferred }
  return max(minimum, min(preferred, (room / width).rounded(.down)))
}

private func dateLine(_ timestamp: Timestamp) -> String {
  Date(timeIntervalSince1970: timestamp / 1000).formatted(.dateTime.weekday(.wide).month(.wide).day())
}

private func clockLine(_ timestamp: Timestamp) -> String {
  Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .omitted, time: .shortened)
}

// MARK: - Broadsheet

/// The tap as a front page: their name as the nameplate over a double rule in
/// their color, the message as the headline, answers in a sidebar.
struct BroadsheetTapView: View {
  let model: OverlayModel
  @State private var on: Bool
  @State private var shown = false

  private static let newsprint = Color(hex: 0xf2ede1)
  private static let ink = Color(hex: 0x1b1813)
  private static let ear = Color(hex: 0x5b554a)
  private static let number = Color(hex: 0x6d665a)

  init(model: OverlayModel) {
    self.model = model
    _on = State(initialValue: model.reduceMotion)
  }

  var body: some View {
    let tap = model.active.tap
    let color = tap.senderColor
    GeometryReader { geometry in
      let u = designScale(geometry.size)
      let narrow = isNarrow(geometry.size)
      VStack(spacing: 0) {
        masthead(tap: tap, u: u, narrow: narrow, width: geometry.size.width)
        rules(color: color, u: u)
        let columns = narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 30 * u))
          : AnyLayout(HStackLayout(alignment: .top, spacing: 48 * u))
        columns {
          headline(tap: tap, u: u)
          side(color: color, u: u, narrow: narrow)
            .opacity(on ? 1 : 0)
            .offset(x: on ? 0 : 14 * u)
            .animation(easeOut.lasting(0.42).delay(0.38), value: on)
        }
        .padding(.top, 38 * u)
      }
      .padding(.top, 34 * u)
      .padding(.horizontal, 64 * u)
      .padding(.bottom, 48 * u)
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
      .background(Self.newsprint)
      .overlay(Rectangle().strokeBorder(color.base, lineWidth: 16 * u))
      .foregroundStyle(Self.ink)
    }
    .opacity(shown ? 1 : 0)
    .onAppear {
      withAnimation(.easeOut(duration: model.reduceMotion ? 0.16 : 0.26)) { shown = true }
      on = true
    }
    .ignoresSafeArea()
  }

  private func masthead(tap: Tap, u: CGFloat, narrow: Bool, width: CGFloat) -> some View {
    let earFont = ThemeFont.font(ThemeFont.serifItalic, 22 * u)
    let room = narrow ? width - 128 * u : width * 0.5
    let plate = fitLine(tap.senderName, font: ThemeFont.serifItalic, preferred: (narrow ? 88 : 112) * u, minimum: 48 * u, room: room)
    return HStack(alignment: .lastTextBaseline, spacing: 24 * u) {
      Text(dateLine(tap.createdAt))
        .font(earFont).foregroundStyle(Self.ear).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      Text(tap.senderName)
        .font(ThemeFont.font(ThemeFont.serifItalic, plate))
        .tracking(-0.02 * plate)
        .lineLimit(1)
        .fixedSize()
        // The nameplate's tracking settles in; scaled rather than re-kerned
        // so nothing is laid out per frame.
        .scaleEffect(x: on ? 1 : 1.18, y: 1)
        .opacity(on ? 1 : 0)
        .animation(.easeOutExpo(0.62), value: on)
        .accessibilityAddTraits(.isHeader)
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Text(ago(tap.createdAt, now: context.date) + (model.active.queued > 0 ? " · \(model.active.queued) more waiting" : ""))
          .font(earFont).foregroundStyle(Self.ear).monospacedDigit().lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.top, 6 * u)
  }

  private func rules(color: PersonColor, u: CGFloat) -> some View {
    VStack(spacing: 5 * u) {
      Rectangle().fill(color.base).frame(height: 7 * u)
        .scaleEffect(x: on ? 1 : 0, y: 1, anchor: .leading)
        .animation(easeInOut.lasting(0.64).delay(0.06), value: on)
      Rectangle().fill(color.base).frame(height: 2 * u)
        .scaleEffect(x: on ? 1 : 0, y: 1, anchor: .leading)
        .animation(easeInOut.lasting(0.64).delay(0.15), value: on)
    }
    .padding(.top, 18 * u)
    .accessibilityHidden(true)
  }

  private func headline(tap: Tap, u: CGFloat) -> some View {
    GeometryReader { slot in
      let style = MessageStyle(
        fontName: ThemeFont.serif, lineHeight: 0.96, tracking: -0.015, color: NSColor(srgbHex: 0x1b1813))
      let size = MessageFit.size(
        tap.body, style: style, room: slot.size,
        preferred: MessageFit.preferred(tap.body, max: 210 * u, min: 92 * u), minimum: 40 * u)
      ThemedMessage(text: tap.body, style: style, size: size, entrance: .rise, reduceMotion: model.reduceMotion)
        .frame(width: slot.size.width, alignment: .topLeading)
    }
    .clipped()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder
  private func side(color: PersonColor, u: CGFloat, narrow: Bool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if model.replying {
        VStack(alignment: .leading, spacing: 14 * u) {
          ThemeReplyField(
            model: model, placeholder: "Write back to \(model.active.tap.senderName)…",
            font: ThemeFont.font(ThemeFont.serifItalic, 34 * u), ink: Self.ink, hint: Color(hex: 0x8a8274)
          )
          .padding(.vertical, 6 * u)
          .overlay(alignment: .bottom) { Rectangle().fill(Self.ink).frame(height: 2 * u) }
          HStack(spacing: 10 * u) {
            sideButton("Send", primary: true, color: color, u: u) { model.sendReply() }
              .disabled(model.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            sideButton("Back", primary: false, color: color, u: u) { model.replying = false }
          }
        }
      } else {
        answer("1", "On it", primary: true, color: color, u: u) { model.answer(.onIt) }
        answer("2", "In ten minutes", primary: false, color: color, u: u) { model.answer(.in10) }
        answer("3", "Write back", primary: false, color: color, u: u, last: true) { model.replying = true }
      }
      Spacer(minLength: 0)
    }
    .padding(.leading, narrow ? 0 : 28 * u)
    .overlay(alignment: .leading) {
      if !narrow { Rectangle().fill(Self.ink).frame(width: 1.5 * u) }
    }
    .frame(width: narrow ? nil : 330 * u)
    .frame(maxHeight: narrow ? nil : .infinity, alignment: .top)
  }

  private func answer(
    _ number: String, _ label: String, primary: Bool, color: PersonColor, u: CGFloat, last: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    ThemeButton(accessibility: label, action: action) { hovered in
      HStack(alignment: .firstTextBaseline, spacing: 16 * u) {
        Text(number).font(ThemeFont.font(ThemeFont.serifItalic, 24 * u))
          .foregroundStyle(primary ? color.ink.opacity(0.7) : Self.number)
          .frame(width: 18 * u, alignment: .leading)
        Text(label).font(ThemeFont.font(ThemeFont.serif, 34 * u))
          .foregroundStyle(primary ? color.ink : Self.ink)
          .lineLimit(1).minimumScaleFactor(0.6)
        Spacer(minLength: 0)
      }
      .offset(x: hovered && !primary ? 8 * u : 0)
      .animation(easeOut.lasting(0.22), value: hovered)
      .padding(.top, 18 * u).padding(.bottom, 16 * u)
      .padding(.leading, primary ? 14 * u : 4 * u).padding(.trailing, 4 * u)
      .background(primary ? color.base : .clear)
      .overlay(alignment: .top) { Rectangle().fill(primary ? color.base : Self.ink).frame(height: 1.5 * u) }
      .overlay(alignment: .bottom) { if last { Rectangle().fill(Self.ink).frame(height: 1.5 * u) } }
    }
  }

  private func sideButton(
    _ label: String, primary: Bool, color: PersonColor, u: CGFloat, action: @escaping () -> Void
  ) -> some View {
    ThemeButton(accessibility: label, action: action) { _ in
      Text(label).font(ThemeFont.font(ThemeFont.serif, 28 * u))
        .foregroundStyle(primary ? color.ink : Self.ink)
        .padding(.vertical, 10 * u).padding(.horizontal, 18 * u)
        .background(primary ? color.base : .clear)
        .overlay(Rectangle().strokeBorder(primary ? color.base : Self.ink, lineWidth: 1.5 * u))
    }
  }
}

// MARK: - Billboard

/// The whole display becomes a poster in their color: huge condensed
/// capitals, their name up a vertical rail, answers as blocks across the foot.
struct BillboardTapView: View {
  let model: OverlayModel
  @State private var on: Bool
  @State private var shown = false

  init(model: OverlayModel) {
    self.model = model
    _on = State(initialValue: model.reduceMotion)
  }

  var body: some View {
    let tap = model.active.tap
    let color = tap.senderColor
    GeometryReader { geometry in
      let u = designScale(geometry.size)
      let narrow = isNarrow(geometry.size)
      let railWidth = (narrow ? 110 : 170) * u
      HStack(spacing: 0) {
        rail(tap: tap, u: u, narrow: narrow, height: geometry.size.height)
          .frame(width: railWidth)
          .overlay(alignment: .trailing) { Rectangle().fill(color.ink).frame(width: 4 * u) }
        VStack(spacing: 0) {
          main(tap: tap, color: color, u: u)
          strip(color: color, u: u, narrow: narrow)
            .offset(y: on ? 0 : (narrow ? 400 : 140) * u)
            .animation(.easeOutExpo(0.48).delay(0.32), value: on)
        }
        .clipped()
      }
      .frame(width: geometry.size.width, height: geometry.size.height)
      .background(color.base)
      .foregroundStyle(color.ink)
      // The color wipes across from the left.
      .mask(alignment: .leading) {
        Rectangle().scaleEffect(x: on || model.reduceMotion ? 1 : 0, y: 1, anchor: .leading)
          .animation(easeInOut.lasting(0.42), value: on)
      }
    }
    .opacity(shown ? 1 : 0)
    .onAppear {
      withAnimation(.easeOut(duration: model.reduceMotion ? 0.16 : 0.01)) { shown = true }
      on = true
    }
    .ignoresSafeArea()
  }

  private func rail(tap: Tap, u: CGFloat, narrow: Bool, height: CGFloat) -> some View {
    let name = tap.senderName.uppercased()
    let size = fitLine(
      name, font: ThemeFont.poster, preferred: (narrow ? 92 : 132) * u, minimum: 40 * u, room: height - 220 * u)
    return VStack {
      Sideways {
        Text(name).font(ThemeFont.font(ThemeFont.poster, size)).tracking(0.01 * size).lineLimit(1).fixedSize()
          .rotationEffect(.degrees(-90))
      }
      .offset(y: on ? 0 : -0.4 * size)
      .opacity(on ? 1 : 0)
      .animation(.easeOutExpo(0.56).delay(0.16), value: on)
      .accessibilityLabel(tap.senderName)
      Spacer(minLength: 0)
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Sideways {
          Text(ago(tap.createdAt, now: context.date).uppercased())
            .font(ThemeFont.font(ThemeFont.posterBold, 24 * u)).tracking(0.06 * 24 * u).monospacedDigit()
            .fixedSize().rotationEffect(.degrees(-90))
        }
      }
    }
    .padding(.top, 40 * u).padding(.bottom, 36 * u)
    .frame(maxHeight: .infinity)
  }

  private func main(tap: Tap, color: PersonColor, u: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Tap from \(tap.senderName)".uppercased())
        Spacer(minLength: 16 * u)
        if model.active.queued > 0 { Text("+\(model.active.queued) waiting".uppercased()).monospacedDigit() }
      }
      .font(ThemeFont.font(ThemeFont.posterBold, 26 * u))
      .tracking(0.08 * 26 * u)
      .lineLimit(1)
      .opacity(on ? 1 : 0)
      .animation(.easeOut(duration: 0.3).delay(0.3), value: on)
      GeometryReader { slot in
        let style = MessageStyle(
          fontName: ThemeFont.poster, lineHeight: 0.86, tracking: -0.005, color: NSColor(srgbHex: color.swatch.ink),
          uppercase: true)
        let size = MessageFit.size(
          tap.body, style: style, room: slot.size,
          preferred: MessageFit.preferred(tap.body, max: 270 * u, min: 108 * u), minimum: 44 * u)
        VStack(spacing: 0) {
          Spacer(minLength: 0)
          ThemedMessage(text: tap.body, style: style, size: size, entrance: .punch, reduceMotion: model.reduceMotion)
        }
        .frame(width: slot.size.width, height: slot.size.height, alignment: .bottomLeading)
      }
      .clipped()
      .padding(.top, 24 * u)
    }
    .padding(.top, 44 * u).padding(.trailing, 64 * u).padding(.bottom, 40 * u).padding(.leading, 56 * u)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder
  private func strip(color: PersonColor, u: CGFloat, narrow: Bool) -> some View {
    let rule = Rectangle().fill(color.ink)
    let layout = narrow ? AnyLayout(VStackLayout(spacing: 0)) : AnyLayout(HStackLayout(spacing: 0))
    VStack(spacing: 0) {
      rule.frame(height: 4 * u)
      if model.replying {
        layout {
          ThemeReplyField(
            model: model, placeholder: "SAY SOMETHING", font: ThemeFont.font(ThemeFont.posterBold, 50 * u),
            ink: color.ink, hint: color.ink.opacity(0.55)
          )
          .padding(.horizontal, 36 * u)
          .frame(height: 128 * u)
          .background(color.ink.opacity(0.1))
          HStack(spacing: 0) {
            rule.frame(width: 4 * u)
            iconBlock(.send, "Send", primary: true, color: color, u: u) { model.sendReply() }
              .disabled(model.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            rule.frame(width: 4 * u)
            iconBlock(.back, "Back", primary: false, color: color, u: u) { model.replying = false }
          }
          .frame(height: 128 * u)
        }
      } else {
        layout {
          block("On it", "1", primary: true, color: color, u: u) { model.answer(.onIt) }
          divider(color: color, u: u, narrow: narrow)
          block("In 10 min", "2", primary: false, color: color, u: u) { model.answer(.in10) }
          divider(color: color, u: u, narrow: narrow)
          block("Reply", "3", primary: false, color: color, u: u) { model.replying = true }
        }
        .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func divider(color: PersonColor, u: CGFloat, narrow: Bool) -> some View {
    Rectangle().fill(color.ink).frame(width: narrow ? nil : 4 * u, height: narrow ? 4 * u : nil)
  }

  private func block(
    _ label: String, _ key: String, primary: Bool, color: PersonColor, u: CGFloat, action: @escaping () -> Void
  ) -> some View {
    ThemeButton(accessibility: label, action: action) { hovered in
      HStack {
        Text(label.uppercased()).font(ThemeFont.font(ThemeFont.poster, 50 * u)).tracking(0.5 * u)
          .lineLimit(1).minimumScaleFactor(0.5)
        Spacer(minLength: 12 * u)
        Text(key).font(ThemeFont.font(ThemeFont.posterBold, 30 * u)).opacity(0.7)
      }
      .padding(.horizontal, 36 * u)
      .frame(maxWidth: .infinity)
      .frame(height: 128 * u)
      .foregroundStyle(primary ? color.base : color.ink)
      .background(primary ? color.ink : hovered ? color.ink.opacity(0.14) : .clear)
    }
  }

  private func iconBlock(
    _ icon: Icon, _ label: String, primary: Bool, color: PersonColor, u: CGFloat, action: @escaping () -> Void
  ) -> some View {
    ThemeButton(accessibility: label, action: action) { _ in
      IconView(icon: icon, size: 44 * u)
        .frame(width: 128 * u, height: 128 * u)
        .foregroundStyle(primary ? color.base : color.ink)
        .background(primary ? color.ink : .clear)
    }
  }
}

// MARK: - Terminal

/// A phosphor console tuned to their color: a status bar in their color, the
/// message as output, a bracketed menu.
struct TerminalTapView: View {
  let model: OverlayModel
  @State private var on: Bool
  @State private var shown = false

  init(model: OverlayModel) {
    self.model = model
    _on = State(initialValue: model.reduceMotion)
  }

  var body: some View {
    let tap = model.active.tap
    let color = tap.senderColor
    let screen = Color.mix(color.swatch.base, 0.16, 0x060708)
    let phosphor = Color.mix(color.swatch.base, 0.38, 0xf1fff3)
    GeometryReader { geometry in
      let u = designScale(geometry.size)
      VStack(spacing: 0) {
        bar(tap: tap, color: color, u: u)
          .offset(y: on ? 0 : -54 * u)
          .animation(.easeOutExpo(0.32).delay(0.12), value: on)
          .zIndex(1)
        console(tap: tap, color: color, phosphor: phosphor, screen: screen, u: u)
          // CRT power-on: a bright line opens to full height.
          .scaleEffect(x: on ? 1 : 0.7, y: on ? 1 : 0.006)
          .overlay(Color.white.opacity(on ? 0 : 0.6).allowsHitTesting(false))
          .animation(easeOut.lasting(0.3), value: on)
      }
      .frame(width: geometry.size.width, height: geometry.size.height)
      .background(screen)
      .overlay(scanlines(u: u).allowsHitTesting(false))
      .foregroundStyle(phosphor)
    }
    .opacity(shown ? 1 : 0)
    .onAppear {
      withAnimation(.linear(duration: model.reduceMotion ? 0.16 : 0.12)) { shown = true }
      on = true
    }
    .ignoresSafeArea()
  }

  private func bar(tap: Tap, color: PersonColor, u: CGFloat) -> some View {
    HStack(spacing: 28 * u) {
      HStack(spacing: 10 * u) {
        Circle().fill(color.ink).frame(width: 11 * u, height: 11 * u)
        Text(tap.senderName).font(ThemeFont.font(ThemeFont.monoBold, 19 * u)).lineLimit(1)
      }
      Text("tty/desk")
      Spacer(minLength: 0)
      TimelineView(.periodic(from: .now, by: 30)) { context in Text(ago(tap.createdAt, now: context.date)) }
      if model.active.queued > 0 { Text("\(model.active.queued) queued") }
    }
    .font(ThemeFont.font(ThemeFont.mono, 19 * u))
    .monospacedDigit()
    .padding(.horizontal, 40 * u)
    .frame(height: 54 * u)
    .frame(maxWidth: .infinity)
    .foregroundStyle(color.ink)
    .background(color.base)
  }

  private func console(tap: Tap, color: PersonColor, phosphor: Color, screen: Color, u: CGFloat) -> some View {
    let handle = String(tap.senderName.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    let style = MessageStyle(
      fontName: ThemeFont.terminal, lineHeight: 0.98, tracking: 0,
      color: NSColor(Color.mix(color.swatch.base, 0.38, 0xf1fff3)), glow: (0xf1fff3, 0.08))
    let words = tap.body.split(whereSeparator: \.isWhitespace).count + 1
    let printed = WordEntrance.print.settled(count: words, characters: tap.body.count)
    return VStack(alignment: .leading, spacing: 0) {
      Text("$ tap --from \(handle.isEmpty ? "someone" : handle)")
        .font(ThemeFont.font(ThemeFont.terminal, 38 * u)).opacity(0.62).lineLimit(1)
        .padding(.bottom, 26 * u)
        .accessibilityHidden(true)
      GeometryReader { slot in
        let size = MessageFit.size(
          tap.body, style: style, room: slot.size,
          preferred: MessageFit.preferred(tap.body, max: 168 * u, min: 84 * u), minimum: 40 * u, cursor: true)
        ThemedMessage(
          text: tap.body, style: style, size: size, entrance: .print, reduceMotion: model.reduceMotion, cursor: true
        )
        .frame(width: slot.size.width, alignment: .topLeading)
      }
      .clipped()
      Group {
        if model.replying {
          HStack(alignment: .firstTextBaseline, spacing: 16 * u) {
            Text("reply>")
            ThemeReplyField(
              model: model, placeholder: "type, then Enter", font: ThemeFont.font(ThemeFont.terminal, 48 * u),
              ink: phosphor, hint: phosphor.opacity(0.45)
            )
            .overlay(alignment: .bottom) {
              Rectangle().stroke(style: StrokeStyle(lineWidth: 2 * u, dash: [8 * u, 6 * u]))
                .foregroundStyle(phosphor.opacity(0.45)).frame(height: 1)
            }
            option("[esc]", "back", primary: false, phosphor: phosphor, screen: screen, u: u) { model.replying = false }
          }
        } else {
          HStack(spacing: 44 * u) {
            option("[1]", "on it", primary: true, phosphor: phosphor, screen: screen, u: u) { model.answer(.onIt) }
            option("[2]", "in 10 min", primary: false, phosphor: phosphor, screen: screen, u: u) { model.answer(.in10) }
            option("[3]", "reply", primary: false, phosphor: phosphor, screen: screen, u: u) { model.replying = true }
          }
        }
      }
      .font(ThemeFont.font(ThemeFont.terminal, 48 * u))
      .padding(.top, 30 * u)
      .opacity(on ? 1 : 0)
      .animation(.linear(duration: 0.01).delay(min(printed + 0.06, 0.7)), value: on)
    }
    .padding(.top, 48 * u).padding(.horizontal, 72 * u).padding(.bottom, 52 * u)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func option(
    _ key: String, _ label: String, primary: Bool, phosphor: Color, screen: Color, u: CGFloat,
    action: @escaping () -> Void
  ) -> some View {
    ThemeButton(accessibility: label, action: action) { hovered in
      (Text(key).foregroundStyle((primary || hovered ? screen : phosphor).opacity(0.6)) + Text(" \(label)"))
        .foregroundStyle(primary || hovered ? screen : phosphor)
        .lineLimit(1)
        .padding(.vertical, 6 * u).padding(.horizontal, 12 * u)
        .background(primary || hovered ? phosphor : .clear)
        .padding(.horizontal, -12 * u)
    }
  }

  /// Static scanlines and a soft vignette, drawn once.
  private func scanlines(u: CGFloat) -> some View {
    Canvas { context, size in
      var y: CGFloat = 0
      while y < size.height {
        context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(.black.opacity(0.22)))
        y += 4
      }
      context.fill(
        Path(CGRect(origin: .zero, size: size)),
        with: .radialGradient(
          Gradient(colors: [.clear, .clear, .black.opacity(0.55)]), center: CGPoint(x: size.width / 2, y: size.height * 0.45),
          startRadius: 0, endRadius: max(size.width, size.height) * 0.75))
    }
    .drawingGroup()
    .accessibilityHidden(true)
  }
}

// MARK: - Note

/// A handwritten note taped to a desk in their color: a second sheet peeks
/// out when more taps are waiting, tick boxes answer.
struct NoteTapView: View {
  let model: OverlayModel
  @State private var on: Bool
  @State private var shown = false

  private static let sheet = Color(hex: 0xfbf8ee)
  private static let under = Color(hex: 0xefe9d8)
  private static let ink = Color(hex: 0x1d2742)
  private static let head = Color(hex: 0x5a6074)
  private static let key = Color(hex: 0x7a8094)

  /// Highlighter strength: light swatches can be bold, dark ones must stay readable under ink.
  private static func highlight(_ color: PersonColor) -> Double {
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

  init(model: OverlayModel) {
    self.model = model
    _on = State(initialValue: model.reduceMotion)
  }

  var body: some View {
    let tap = model.active.tap
    let color = tap.senderColor
    GeometryReader { geometry in
      let u = designScale(geometry.size)
      let narrow = isNarrow(geometry.size)
      let written = writtenAt(tap.body)
      ZStack {
        if model.active.queued > 0 {
          RoundedRectangle(cornerRadius: 6 * u).fill(Self.under)
            .shadow(color: .black.opacity(0.25), radius: 20 * u, y: 18 * u)
            .padding(EdgeInsets(top: 14 * u, leading: 18 * u, bottom: -10 * u, trailing: -6 * u))
            .rotationEffect(.degrees(on ? 2.4 : 6))
            .offset(y: on ? 0 : 90 * u)
            .opacity(on ? 1 : 0)
            .animation(.easeOutExpo(0.62).delay(0.06), value: on)
            .accessibilityHidden(true)
        }
        paper(color: color, u: u)
        content(tap: tap, color: color, u: u, written: written)
          .padding(narrow ? EdgeInsets(top: 56 * u, leading: 48 * u, bottom: 40 * u, trailing: 48 * u)
            : EdgeInsets(top: 64 * u, leading: 84 * u, bottom: 48 * u, trailing: 84 * u))
          .offset(y: on ? 0 : 70 * u)
          .opacity(on ? 1 : 0)
          .animation(.easeOutExpo(0.56), value: on)
      }
      .frame(maxWidth: 1100 * u, maxHeight: 780 * u)
      .padding(narrow ? EdgeInsets(top: 40 * u, leading: 30 * u, bottom: 40 * u, trailing: 30 * u)
        : EdgeInsets(top: 56 * u, leading: 64 * u, bottom: 56 * u, trailing: 64 * u))
      .frame(width: geometry.size.width, height: geometry.size.height)
      .background(color.base)
    }
    .opacity(shown ? 1 : 0)
    .onAppear {
      withAnimation(.easeOut(duration: model.reduceMotion ? 0.16 : 0.24)) { shown = true }
      on = true
    }
    .ignoresSafeArea()
  }

  /// When the last word has been written (Note's entrance), capped.
  private func writtenAt(_ body: String) -> Double {
    WordEntrance.write.settled(count: 0, characters: body.count)
  }

  /// The sheet and its tape tilt; the writing on it stays level so typing a
  /// reply is never rotated.
  private func paper(color: PersonColor, u: CGFloat) -> some View {
    RoundedRectangle(cornerRadius: 6 * u).fill(Self.sheet)
      .shadow(color: .black.opacity(0.12), radius: 2 * u, y: 2 * u)
      .shadow(color: .black.opacity(0.35), radius: 30 * u, y: 34 * u)
      .overlay(alignment: .top) {
        Rectangle().fill(Color.mix(color.swatch.base, 0.6, 0xffffff)).opacity(on ? 0.88 : 0)
          .frame(width: 210 * u, height: 48 * u)
          .shadow(color: .black.opacity(0.12), radius: 1 * u, y: 1 * u)
          .rotationEffect(.degrees(-3))
          .scaleEffect(on ? 1 : 1.25)
          .offset(y: -22 * u)
          .animation(easeOut.lasting(0.18).delay(0.42), value: on)
      }
      .rotationEffect(.degrees(on ? -1.1 : -5))
      .offset(y: on ? 0 : 70 * u)
      .opacity(on ? 1 : 0)
      .animation(.easeOutExpo(0.56), value: on)
      .accessibilityHidden(true)
  }

  private func content(tap: Tap, color: PersonColor, u: CGFloat, written: Double) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(clockLine(tap.createdAt))
        Spacer(minLength: 0)
        if model.active.queued > 0 { Text("\(model.active.queued) more underneath") }
      }
      .font(ThemeFont.font(ThemeFont.hand, 34 * u))
      .foregroundStyle(Self.head)
      .monospacedDigit()
      GeometryReader { slot in
        let style = MessageStyle(
          fontName: ThemeFont.hand, lineHeight: 1.04, tracking: 0, color: NSColor(srgbHex: 0x1d2742))
        let size = MessageFit.size(
          tap.body, style: style, room: slot.size,
          preferred: MessageFit.preferred(tap.body, max: 150 * u, min: 76 * u), minimum: 40 * u)
        let line = (size * 1.04).rounded()
        let inset = style.overshoot(size: size)
        ThemedMessage(text: tap.body, style: style, size: size, entrance: .write, reduceMotion: model.reduceMotion)
          .frame(width: slot.size.width, alignment: .topLeading)
          .frame(width: slot.size.width, height: slot.size.height, alignment: .topLeading)
          .background(alignment: .topLeading) {
            // Ruled lines under the writing, down the page.
            Canvas { context, canvas in
              var y = inset + line + size * 0.1 - 2
              while y < canvas.height {
                context.fill(Path(CGRect(x: 0, y: y, width: canvas.width, height: 2)), with: .color(Self.ink.opacity(0.13)))
                y += line
              }
            }
            .accessibilityHidden(true)
          }
      }
      .clipped()
      .padding(.top, 14 * u)
      Text("— \(tap.senderName)")
        .font(ThemeFont.font(ThemeFont.hand, 64 * u))
        .lineLimit(1).minimumScaleFactor(0.5)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .mask(alignment: .leading) {
          Rectangle().scaleEffect(x: on ? 1 : 0, y: 1, anchor: .leading)
            .animation(.linear(duration: model.reduceMotion ? 0 : 0.26).delay(model.reduceMotion ? 0 : written), value: on)
        }
        .padding(.top, 4 * u)
      answers(color: color, u: u)
        .padding(.top, 22 * u)
        .overlay(alignment: .top) {
          Rectangle().stroke(style: StrokeStyle(lineWidth: 2 * u, dash: [10 * u, 8 * u]))
            .foregroundStyle(Self.ink.opacity(0.18)).frame(height: 1)
        }
        .padding(.top, 14 * u)
        .opacity(on ? 1 : 0)
        .offset(y: on ? 0 : 8 * u)
        .animation(easeOut.lasting(0.32).delay(min(written, 0.9)), value: on)
    }
    .foregroundStyle(Self.ink)
  }

  @ViewBuilder
  private func answers(color: PersonColor, u: CGFloat) -> some View {
    let highlight = color.base.opacity(Self.highlight(color))
    if model.replying {
      HStack(alignment: .lastTextBaseline, spacing: 22 * u) {
        ThemeReplyField(
          model: model, placeholder: "Write back…", font: ThemeFont.font(ThemeFont.hand, 50 * u), ink: Self.ink,
          hint: Color(hex: 0x9a9fb0)
        )
        .padding(.horizontal, 4 * u)
        .overlay(alignment: .bottom) { Rectangle().fill(Self.ink).frame(height: 2.5 * u) }
        ThemeButton(accessibility: "Send", action: { model.sendReply() }) { _ in
          Text("Send").font(ThemeFont.font(ThemeFont.hand, 44 * u))
            .padding(.horizontal, 8 * u).background(highlighter(highlight, u: u))
        }
        .disabled(model.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        ThemeButton(accessibility: "Back", action: { model.replying = false }) { _ in
          Text("Back").font(ThemeFont.font(ThemeFont.hand, 44 * u))
        }
      }
    } else {
      HStack(spacing: 40 * u) {
        tick("On it", "1", highlight: highlight, u: u) { model.answer(.onIt) }
        tick("In 10 min", "2", highlight: nil, u: u) { model.answer(.in10) }
        tick("Reply", "3", highlight: nil, u: u) { model.replying = true }
      }
    }
  }

  private func highlighter(_ color: Color, u: CGFloat) -> some View {
    UnevenRoundedRectangle(
      topLeadingRadius: 4 * u, bottomLeadingRadius: 12 * u, bottomTrailingRadius: 6 * u, topTrailingRadius: 10 * u
    )
    .fill(color)
    .padding(.top, 10 * u).padding(.bottom, 4 * u)
  }

  private func tick(
    _ label: String, _ key: String, highlight: Color?, u: CGFloat, action: @escaping () -> Void
  ) -> some View {
    ThemeButton(accessibility: label, action: action) { hovered in
      HStack(spacing: 14 * u) {
        TickBox(checked: hovered).stroke(Self.ink, style: StrokeStyle(lineWidth: 3 * u, lineCap: .round, lineJoin: .round))
          .frame(width: 36 * u, height: 36 * u)
          .animation(easeOut.lasting(0.2), value: hovered)
        Text(label).font(ThemeFont.font(ThemeFont.hand, 46 * u))
          .padding(.horizontal, highlight == nil ? 0 : 6 * u)
          .background { if let highlight { highlighter(highlight, u: u) } }
        Text(key).font(ThemeFont.font(ThemeFont.hand, 26 * u)).foregroundStyle(Self.key)
      }
      .padding(.vertical, 4 * u).padding(.horizontal, 6 * u)
    }
  }
}

/// A hand-drawn box whose tick draws in on hover.
private struct TickBox: Shape {
  var checked: Bool
  var animatableData: Double {
    get { progress }
    set { progress = newValue }
  }
  private var progress: Double

  init(checked: Bool) {
    self.checked = checked
    progress = checked ? 1 : 0
  }

  func path(in rect: CGRect) -> Path {
    let s = rect.width / 36
    var path = Path()
    path.move(to: CGPoint(x: 5 * s, y: 6.5 * s))
    path.addCurve(to: CGPoint(x: 31 * s, y: 6.1 * s), control1: CGPoint(x: 13 * s, y: 5.3 * s), control2: CGPoint(x: 22 * s, y: 5.1 * s))
    path.addCurve(to: CGPoint(x: 31.3 * s, y: 29.7 * s), control1: CGPoint(x: 31.7 * s, y: 14.1 * s), control2: CGPoint(x: 31.9 * s, y: 21.7 * s))
    path.addCurve(to: CGPoint(x: 5.7 * s, y: 29.8 * s), control1: CGPoint(x: 22.7 * s, y: 30.6 * s), control2: CGPoint(x: 14.3 * s, y: 30.5 * s))
    path.addCurve(to: CGPoint(x: 5 * s, y: 6.5 * s), control1: CGPoint(x: 5 * s, y: 22 * s), control2: CGPoint(x: 4.6 * s, y: 14 * s))
    path.closeSubpath()
    var mark = Path()
    mark.move(to: CGPoint(x: 9 * s, y: 18.5 * s))
    mark.addLine(to: CGPoint(x: 15 * s, y: 25 * s))
    mark.addLine(to: CGPoint(x: 29 * s, y: 9 * s))
    path.addPath(mark.trimmedPath(from: 0, to: progress))
    return path
  }
}
