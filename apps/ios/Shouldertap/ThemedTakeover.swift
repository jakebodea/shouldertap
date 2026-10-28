import ShouldertapCore
import SwiftUI

// The takeover in its sender's theme (docs/patrons.md, "Sender themes"): a
// phone-sized take on each Mac composition (apps/macos ThemeViews.swift),
// with the same answers. Default stays the Frame in Receiving.swift.

/// What every composition needs from the takeover: the tap, the reply being
/// typed, and how to answer.
struct TakeoverControls {
  let active: ActiveTap
  @Binding var replying: Bool
  @Binding var reply: String
  var focused: FocusState<Bool>.Binding
  let reduceMotion: Bool
  let answer: (TapResponse) -> Void

  var tap: Tap { active.tap }
  var color: PersonColor { tap.senderColor }
  var options: [QuickReply] { tap.quickReplies }
  /// A sender's own words get no icon: a tick or a clock might not fit them.
  var custom: Bool { tap.replies != nil }
  var trimmed: String { reply.trimmingCharacters(in: .whitespacesAndNewlines) }

  func send() {
    guard !trimmed.isEmpty else { return }
    answer(TapResponse(kind: .text, text: trimmed))
  }

  func setReplying(_ on: Bool) {
    withAnimation(reduceMotion ? nil : .outExpo(0.4)) { replying = on }
  }

  /// `largest` for a few words down to `smallest` for a paragraph.
  func messageSize(_ largest: CGFloat, _ smallest: CGFloat) -> CGFloat {
    let t = min(1, max(0, Double(tap.body.count - 14) / 70))
    return (largest - (largest - smallest) * t.squareRoot()).rounded()
  }
}

/// A message that swaps in as the next tap arrives.
private struct Message: View {
  let c: TakeoverControls
  let font: Font
  var tracking: CGFloat = 0
  var lineSpacing: CGFloat = 0
  var uppercase = false
  /// Take the height left over (the answers sit at the foot), or only its own.
  var fills = true

  var body: some View {
    Text(uppercase ? c.tap.body.uppercased() : c.tap.body)
      .font(font)
      .tracking(tracking)
      .lineSpacing(lineSpacing)
      .minimumScaleFactor(0.4)
      .frame(maxWidth: .infinity, maxHeight: fills ? .infinity : nil, alignment: .topLeading)
      .fixedSize(horizontal: false, vertical: !fills)
      .textSelection(.enabled)
      .id(c.tap.id)
      .transition(c.reduceMotion ? .opacity : .rise)
  }
}

/// "2 min ago", kept current.
private struct Ago: View {
  let tap: Tap
  var lowercase = false

  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      let text = relativeTime(tap.createdAt, now: context.date)
      Text(lowercase ? text.lowercased() : text)
    }
  }
}

/// Presses dim and shrink a little, like `PillStyle`.
private struct Press: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.7 : 1)
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
  }
}

// MARK: - Broadsheet

/// A front page framed in their color: their name as the italic nameplate
/// over a double rule, the message as the headline, answers as ruled lines.
struct BroadsheetTakeover: View {
  let c: TakeoverControls
  private let ink = Color(hex: ThemeInk.news)
  private let ear = Color(hex: 0x5b554a)

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Ago(tap: c.tap)
        Spacer()
        Text(c.active.queued > 0 ? "\(c.active.queued) more waiting" : "Late edition")
      }
      .font(ThemeFont.font(ThemeFont.serif, 15, relativeTo: .footnote))
      .foregroundStyle(ear)
      Text(c.tap.senderName)
        .font(ThemeFont.font(ThemeFont.serifItalic, 54, relativeTo: .largeTitle))
        .lineLimit(1)
        .minimumScaleFactor(0.4)
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
      VStack(spacing: 3) {
        Rectangle().fill(c.color.base).frame(height: 4)
        Rectangle().fill(c.color.base).frame(height: 1.5)
      }
      .padding(.bottom, 18)
      let size = c.messageSize(64, 36)
      Message(c: c, font: ThemeFont.font(ThemeFont.serif, size, relativeTo: .largeTitle), lineSpacing: -0.12 * size)
      if c.replying { replyRows } else { answerRows }
    }
    .foregroundStyle(ink)
    .padding(.horizontal, 22)
    .padding(.vertical, 12)
    .background(Color(hex: ThemeInk.newsprint))
    .padding(10)
    .background(c.color.base.ignoresSafeArea())
  }

  private var answerRows: some View {
    VStack(spacing: 0) {
      row(1, c.options[0].label, icon: c.custom ? nil : .onIt, primary: true) { c.answer(c.options[0].response) }
        .accessibilityIdentifier("takeover-on-it")
      row(2, c.options[1].label, icon: c.custom ? nil : .in10) { c.answer(c.options[1].response) }
      row(3, "Write back", icon: .reply) { c.setReplying(true) }
    }
  }

  private var replyRows: some View {
    VStack(spacing: 0) {
      TextField("Write back to \(c.tap.senderName)", text: c.$reply, axis: .vertical)
        .font(ThemeFont.font(ThemeFont.serif, 24, relativeTo: .title3))
        .lineLimit(1...4)
        .focused(c.focused)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(ink).frame(height: 1) }
        .onAppear { c.focused.wrappedValue = true }
      row(1, "Send", icon: .send, primary: true) { c.send() }
        .disabled(c.trimmed.isEmpty)
        .padding(.top, 12)
      row(2, "Back", icon: nil) { c.setReplying(false) }
    }
  }

  private func row(_ number: Int, _ label: String, icon: Icon?, primary: Bool = false, action: @escaping () -> Void)
    -> some View
  {
    Button(action: action) {
      HStack(spacing: 12) {
        Text("\(number)").font(ThemeFont.font(ThemeFont.serifItalic, 20)).opacity(0.6)
        Text(label).font(ThemeFont.font(ThemeFont.serif, 26, relativeTo: .title2)).lineLimit(1).minimumScaleFactor(0.6)
        Spacer(minLength: 0)
        if let icon { IconView(icon: icon, size: 20) }
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 54)
      .foregroundStyle(primary ? c.color.ink : ink)
      .background(primary ? c.color.base : .clear)
      .overlay(alignment: .top) { if !primary { Rectangle().fill(ink.opacity(0.35)).frame(height: 1) } }
    }
    .buttonStyle(Press())
  }
}

// MARK: - Billboard

/// Their color edge to edge, a kicker, the message in poster capitals at the
/// foot, answers as blocks.
struct BillboardTakeover: View {
  let c: TakeoverControls

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        HStack(spacing: 0) {
          Text("Tap from \(c.tap.senderName) · ".uppercased()).lineLimit(1)
          Ago(tap: c.tap).textCase(.uppercase)
        }
        Spacer()
        if c.active.queued > 0 { Text("+\(c.active.queued) waiting".uppercased()) }
      }
      .font(ThemeFont.font(ThemeFont.posterBold, 20, relativeTo: .headline))
      .tracking(1)
      .opacity(0.8)
      let size = c.messageSize(112, 52)
      Message(c: c, font: ThemeFont.font(ThemeFont.poster, size, relativeTo: .largeTitle), lineSpacing: -0.16 * size, uppercase: true)
        .frame(maxHeight: .infinity, alignment: .bottom)
      if c.replying { replyBlocks } else { answerBlocks }
    }
    .foregroundStyle(c.color.ink)
    .padding(.horizontal, 20)
    .padding(.top, 8)
    .padding(.bottom, 12)
    .background(c.color.base.ignoresSafeArea())
  }

  private var answerBlocks: some View {
    VStack(spacing: 8) {
      block(c.options[0].label, icon: c.custom ? nil : .onIt, filled: true) { c.answer(c.options[0].response) }
        .accessibilityIdentifier("takeover-on-it")
      HStack(spacing: 8) {
        block(c.options[1].label, icon: c.custom ? nil : .in10) { c.answer(c.options[1].response) }
        block("Reply", icon: .reply) { c.setReplying(true) }
      }
    }
  }

  private var replyBlocks: some View {
    VStack(spacing: 8) {
      TextField("Reply to \(c.tap.senderName)", text: c.$reply, axis: .vertical)
        .font(ThemeFont.font(ThemeFont.posterBold, 26, relativeTo: .title2))
        .lineLimit(1...4)
        .focused(c.focused)
        .padding(14)
        .overlay(Rectangle().strokeBorder(c.color.ink, lineWidth: 2.5))
        .onAppear { c.focused.wrappedValue = true }
      HStack(spacing: 8) {
        block("Back", icon: nil) { c.setReplying(false) }
        block("Send", icon: .send, filled: true) { c.send() }.disabled(c.trimmed.isEmpty)
      }
    }
  }

  private func block(_ label: String, icon: Icon?, filled: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let icon { IconView(icon: icon, size: 22) }
        Text(label.uppercased()).lineLimit(1).minimumScaleFactor(0.5)
      }
      .font(ThemeFont.font(ThemeFont.poster, 28, relativeTo: .title2))
      .tracking(0.5)
      .padding(.horizontal, 12)
      .frame(maxWidth: .infinity, minHeight: 60)
      .foregroundStyle(filled ? c.color.base : c.color.ink)
      .background(filled ? c.color.ink : .clear)
      .overlay { if !filled { Rectangle().strokeBorder(c.color.ink, lineWidth: 2.5) } }
    }
    .buttonStyle(Press())
  }
}

// MARK: - Terminal

/// A phosphor console tuned to their color: a status bar in their color, the
/// message as output, a bracketed menu, scanlines.
struct TerminalTakeover: View {
  let c: TakeoverControls

  private var phosphor: Color { ThemeInk.phosphor(c.color) }
  private var handle: String {
    String(c.tap.senderName.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      bar
      VStack(alignment: .leading, spacing: 14) {
        Text("$ tap --from \(handle.isEmpty ? "someone" : handle)")
          .font(ThemeFont.font(ThemeFont.terminal, 22, relativeTo: .body))
          .lineLimit(1)
          .opacity(0.62)
        Message(c: c, font: ThemeFont.font(ThemeFont.terminal, c.messageSize(60, 34), relativeTo: .largeTitle))
          .shadow(color: phosphor.opacity(0.45), radius: 8)
        if c.replying { replyMenu } else { menu }
      }
      .foregroundStyle(phosphor)
      .padding(.horizontal, 20)
      .padding(.top, 18)
      .padding(.bottom, 12)
    }
    .background(ThemeInk.screen(c.color).ignoresSafeArea())
    .overlay { Scanlines().ignoresSafeArea() }
  }

  private var bar: some View {
    HStack(spacing: 10) {
      Circle().fill(c.color.ink).frame(width: 8, height: 8)
      Text(c.tap.senderName).lineLimit(1)
      Spacer(minLength: 8)
      Ago(tap: c.tap, lowercase: true)
      if c.active.queued > 0 { Text("\(c.active.queued) queued") }
    }
    .font(ThemeFont.font(ThemeFont.mono, 14, relativeTo: .footnote))
    .monospacedDigit()
    .foregroundStyle(c.color.ink)
    .padding(.horizontal, 20)
    .frame(height: 40)
    .background(c.color.base.ignoresSafeArea(edges: .top))
  }

  private var menu: some View {
    VStack(alignment: .leading, spacing: 4) {
      option("1", c.options[0].label.lowercased(), selected: true) { c.answer(c.options[0].response) }
        .accessibilityIdentifier("takeover-on-it")
      option("2", c.options[1].label.lowercased()) { c.answer(c.options[1].response) }
      option("3", "reply") { c.setReplying(true) }
    }
  }

  private var replyMenu: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(">")
        TextField("", text: c.$reply, prompt: Text("reply to \(handle)").foregroundStyle(phosphor.opacity(0.45)), axis: .vertical)
          .lineLimit(1...4)
          .focused(c.focused)
          .textInputAutocapitalization(.never)
          .tint(phosphor)
          .onAppear { c.focused.wrappedValue = true }
      }
      .font(ThemeFont.font(ThemeFont.terminal, 30, relativeTo: .title2))
      .padding(.vertical, 8)
      option("↵", "send", selected: !c.trimmed.isEmpty) { c.send() }.disabled(c.trimmed.isEmpty)
      option("esc", "back") { c.setReplying(false) }
    }
  }

  /// `[1] on it`; the selected one in inverse video.
  private func option(_ key: String, _ label: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text("[\(key)] \(label)")
        .font(ThemeFont.font(ThemeFont.terminal, 32, relativeTo: .title2))
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
        .foregroundStyle(selected ? ThemeInk.screen(c.color) : phosphor)
        .background(selected ? phosphor : .clear)
    }
    .buttonStyle(Press())
  }
}

// MARK: - Note

/// A cream sheet taped to a desk of their color, written by hand on ruled
/// lines and signed; tick boxes answer, the first under a highlighter. The
/// sheet tilts, the writing stays level.
struct NoteTakeover: View {
  let c: TakeoverControls
  private let pen = Color(hex: ThemeInk.pen)

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      let size = c.messageSize(60, 36)
      Message(c: c, font: ThemeFont.font(ThemeFont.hand, size, relativeTo: .largeTitle), lineSpacing: -0.1 * size, fills: false)
      HStack(alignment: .firstTextBaseline) {
        if c.active.queued > 0 { Text("+\(c.active.queued) under this one").opacity(0.6) }
        Spacer()
        Text("— \(c.tap.senderName)").lineLimit(1)
      }
      .font(ThemeFont.font(ThemeFont.hand, 28, relativeTo: .title2))
      Ago(tap: c.tap)
        .font(ThemeFont.font(ThemeFont.hand, 20, relativeTo: .body))
        .opacity(0.6)
        .frame(maxWidth: .infinity, alignment: .trailing)
      Spacer(minLength: 12)
      if c.replying { replyTicks } else { ticks }
    }
    .foregroundStyle(pen)
    .padding(.horizontal, 26)
    .padding(.top, 30)
    .padding(.bottom, 22)
    .background { sheet }
    .padding(.horizontal, 16)
    .padding(.vertical, 18)
    .background(c.color.base.ignoresSafeArea())
  }

  private var sheet: some View {
    Color(hex: ThemeInk.sheet)
      .overlay { RuledLines(top: 64, spacing: 40) }
      .overlay(alignment: .top) {
        Rectangle().fill(.white.opacity(0.6)).frame(width: 96, height: 26).rotationEffect(.degrees(4)).offset(y: -12)
      }
      .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
      .rotationEffect(.degrees(-1.5))
  }

  private var ticks: some View {
    VStack(alignment: .leading, spacing: 2) {
      tick(c.options[0].label, highlighted: true) { c.answer(c.options[0].response) }
        .accessibilityIdentifier("takeover-on-it")
      tick(c.options[1].label) { c.answer(c.options[1].response) }
      tick("Write back") { c.setReplying(true) }
    }
  }

  private var replyTicks: some View {
    VStack(alignment: .leading, spacing: 2) {
      TextField("Write back to \(c.tap.senderName)", text: c.$reply, axis: .vertical)
        .font(ThemeFont.font(ThemeFont.hand, 30, relativeTo: .title2))
        .lineLimit(1...4)
        .focused(c.focused)
        .tint(pen)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(pen.opacity(0.5)).frame(height: 1) }
        .onAppear { c.focused.wrappedValue = true }
      tick("Send it", highlighted: !c.trimmed.isEmpty) { c.send() }.disabled(c.trimmed.isEmpty)
      tick("Never mind") { c.setReplying(false) }
    }
  }

  private func tick(_ label: String, highlighted: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 14) {
        RoundedRectangle(cornerRadius: 3).strokeBorder(pen, lineWidth: 2).frame(width: 26, height: 26).rotationEffect(.degrees(-3))
        Text(label)
          .font(ThemeFont.font(ThemeFont.hand, 32, relativeTo: .title2))
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .padding(.horizontal, 4)
          .background(highlighted ? c.color.base.opacity(ThemeInk.highlight(c.color)) : .clear)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 48)
    }
    .buttonStyle(Press())
  }
}
