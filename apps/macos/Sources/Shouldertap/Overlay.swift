import AppKit
import ShouldertapCore
import SwiftUI

/// Borderless window that sits above other apps, including full-screen ones
/// and every Space, and can take keyboard focus for a typed reply.
final class OverlayWindow: NSWindow {
  init(screen: NSScreen) {
    super.init(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    level = .screenSaver
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    isReleasedWhenClosed = false
    animationBehavior = .none
    setFrame(screen.frame, display: false)
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

/// One display's copy of the overlay. Every copy answers the same tap; each
/// keeps its own reply state.
@MainActor @Observable
final class OverlayModel {
  var active: ActiveTap
  var replying = false
  var reply = ""
  let reduceMotion: Bool
  @ObservationIgnored let respond: (_ tapId: String, TapResponse) -> Void

  init(active: ActiveTap, respond: @escaping (_ tapId: String, TapResponse) -> Void) {
    self.active = active
    self.respond = respond
    reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  func answer(_ response: TapResponse) {
    respond(active.tap.id, response)
  }

  func sendReply() {
    let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    respond(active.tap.id, TapResponse(kind: .text, text: String(text.prefix(maxReplyLength))))
  }
}

/// Presents one overlay per connected display for the store's active tap and
/// tears them all down together.
@MainActor
final class OverlayController {
  private let store: ReceiverStore
  private var windows: [(window: OverlayWindow, model: OverlayModel, screen: NSScreen)] = []
  private var keyMonitor: Any?

  init(store: ReceiverStore) {
    self.store = store
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.displaysChanged() }
    }
  }

  /// Show, update or hide to match the store.
  func update(_ active: ActiveTap?) {
    guard let active else {
      hide()
      return
    }
    if windows.isEmpty || !matchesScreens() {
      rebuild(active)
      focus()
    } else {
      for entry in windows where entry.model.active != active {
        let newTap = entry.model.active.tap.id != active.tap.id
        withAnimation(newTap ? .easeOutExpo(0.6) : nil) {
          entry.model.active = active
          if newTap {
            entry.model.replying = false
            entry.model.reply = ""
          }
        }
      }
    }
    installKeyMonitor()
    store.didDisplay(tapId: active.tap.id)
  }

  private func rebuild(_ active: ActiveTap) {
    tearDown()
    for screen in NSScreen.screens {
      let window = OverlayWindow(screen: screen)
      let model = OverlayModel(active: active) { [weak store] tapId, response in
        store?.respond(tapId: tapId, response: response)
      }
      let host = NSHostingView(rootView: OverlayView(model: model))
      host.frame = NSRect(origin: .zero, size: screen.frame.size)
      window.contentView = host
      window.orderFrontRegardless()
      windows.append((window, model, screen))
    }
  }

  /// Leave with a 420ms fade (docs/design.md, "Motion"). The next tap, if any,
  /// builds fresh windows, so fading ones never block it.
  private func hide() {
    removeKeyMonitor()
    guard !windows.isEmpty else { return }
    let leaving = windows.map(\.window)
    windows.removeAll()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.42
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.2, 1)
      for window in leaving { window.animator().alphaValue = 0 }
    } completionHandler: {
      MainActor.assumeIsolated {
        for window in leaving {
          window.orderOut(nil)
          window.contentView = nil
        }
      }
    }
  }

  private func tearDown() {
    for entry in windows {
      entry.window.orderOut(nil)
      entry.window.contentView = nil
    }
    windows.removeAll()
  }

  private func displaysChanged() {
    guard let active = windows.first?.model.active else { return }
    rebuild(active)
    focus()
  }

  private func matchesScreens() -> Bool {
    let screens = NSScreen.screens
    return screens.count == windows.count && zip(screens, windows).allSatisfy { $0.frame == $1.screen.frame }
  }

  /// Keyboard focus goes to the overlay on the display with the pointer.
  private func focus() {
    NSApp.activate(ignoringOtherApps: true)
    let mouse = NSEvent.mouseLocation
    let target = windows.first { NSMouseInRect(mouse, $0.screen.frame, false) } ?? windows.first
    target?.window.makeKeyAndOrderFront(nil)
  }

  // MARK: Keyboard

  /// 1, 2, 3 answer and Escape leaves reply mode, on the display whose window
  /// has the keyboard. A local monitor sees them wherever SwiftUI focus is.
  private func installKeyMonitor() {
    guard keyMonitor == nil else { return }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      MainActor.assumeIsolated { self?.handle(event) ?? false } ? nil : event
    }
  }

  private func removeKeyMonitor() {
    if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    keyMonitor = nil
  }

  /// Returns true when the key was an overlay shortcut.
  private func handle(_ event: NSEvent) -> Bool {
    guard let model = windows.first(where: { $0.window === event.window })?.model,
      event.modifierFlags.intersection([.command, .control, .option]).isEmpty
    else { return false }
    if event.keyCode == 53 {  // Escape
      model.replying = false
      return true
    }
    guard !model.replying else { return false }
    switch event.charactersIgnoringModifiers {
    case "1": model.answer(.onIt)
    case "2": model.answer(.in10)
    case "3": model.replying = true
    default: return false
    }
    return true
  }
}

// MARK: - Views

/// "Frame": the sender's color covers the display and holds a calm paper page
/// with the message (docs/design.md, "Surfaces").
struct OverlayView: View {
  let model: OverlayModel
  @State private var arrived = false

  var body: some View {
    let tap = model.active.tap
    let color = tap.senderColor
    GeometryReader { geometry in
      VStack(alignment: .leading, spacing: 0) {
        band(tap: tap, color: color)
        VStack(alignment: .leading, spacing: 40) {
          MessageText(text: tap.body, size: fitMessage(tap.body, in: geometry.size))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .id(tap.id)
            .transition(
              model.reduceMotion
                ? .opacity : .asymmetric(insertion: .opacity.combined(with: .offset(y: 18)), removal: .opacity))
          if model.replying {
            ReplyRow(model: model, color: color)
          } else {
            AnswerRow(model: model, color: color)
          }
        }
        .padding(.vertical, 64)
        .padding(.horizontal, 72)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Paper.paper))
        .padding(.horizontal, 40)
        .padding(.bottom, 40)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(color.base)
    }
    .opacity(arrived ? 1 : 0)
    .onAppear {
      withAnimation(.easeOutExpo(0.52)) { arrived = true }
    }
    .ignoresSafeArea()
  }

  private func band(tap: Tap, color: PersonColor) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 18) {
      Text(tap.senderName)
        .font(Bricolage.bold(36))
        .tracking(-0.72)
        .lineLimit(1)
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Text(ago(tap.createdAt, now: context.date))
          .font(Bricolage.medium(20))
          .monospacedDigit()
          .opacity(0.72)
      }
      if model.active.queued > 0 {
        Text("\(model.active.queued) more waiting")
          .font(Bricolage.medium(20))
          .monospacedDigit()
          .opacity(0.85)
      }
    }
    .foregroundStyle(color.ink)
    .padding(.top, 30)
    .padding(.horizontal, 72)
    .frame(height: 96, alignment: .topLeading)
  }
}

private struct AnswerRow: View {
  let model: OverlayModel
  let color: PersonColor

  var body: some View {
    HStack(spacing: 14) {
      Pill(icon: .onIt, label: "On it", hint: "1", fill: color) { model.answer(.onIt) }
      Pill(icon: .in10, label: "In 10 min", hint: "2") { model.answer(.in10) }
      Pill(icon: .reply, label: "Reply", hint: "3") { model.replying = true }
    }
  }
}

private struct ReplyRow: View {
  @Bindable var model: OverlayModel
  let color: PersonColor
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 14) {
      TextField("", text: $model.reply, prompt: Text("Reply to \(model.active.tap.senderName)").foregroundStyle(Paper.tone))
        .textFieldStyle(.plain)
        .font(Bricolage.medium(24))
        .foregroundStyle(Paper.ink)
        .focused($focused)
        .onSubmit { model.sendReply() }
        .onChange(of: model.reply) { _, text in
          if text.count > maxReplyLength { model.reply = String(text.prefix(maxReplyLength)) }
        }
        .padding(.horizontal, 30)
        .frame(height: 68)
        .background(Capsule().fill(Paper.faint))
        .overlay(Capsule().strokeBorder(Paper.ink, lineWidth: 2))
      Pill(icon: .send, label: "Send", fill: color) { model.sendReply() }
        .disabled(model.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      Pill(icon: .back, accessibilityLabel: "Back") { model.replying = false }
    }
    .onAppear { focused = true }
  }
}

/// The overlay's rounded answer buttons: 68pt tall, a 2pt line, or filled in
/// the sender's color for the primary answer.
private struct Pill: View {
  let icon: Icon
  var label: String?
  var hint: String?
  var fill: PersonColor?
  var accessibilityLabel: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        IconView(icon: icon, size: 26)
        if let label {
          Text(label).font(Bricolage.bold(24))
        }
        if let hint {
          Text(hint).font(Bricolage.medium(15)).monospacedDigit().opacity(0.5).padding(.leading, 4)
        }
      }
      .padding(.horizontal, label == nil ? 0 : 28)
      .frame(width: label == nil ? 68 : nil, height: 68)
      .contentShape(Capsule())
    }
    .buttonStyle(PillStyle(fill: fill))
    // Answers come from a click or the 1/2/3 keys, never a stray space or
    // return typed while the overlay appeared.
    .focusable(false)
    .accessibilityLabel(accessibilityLabel ?? label ?? "")
  }
}

private struct PillStyle: ButtonStyle {
  let fill: PersonColor?

  func makeBody(configuration: Configuration) -> some View {
    PillChrome(label: configuration.label, pressed: configuration.isPressed, fill: fill)
  }
}

private struct PillChrome<Label: View>: View {
  let label: Label
  let pressed: Bool
  let fill: PersonColor?
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovered = false

  var body: some View {
    label
      .foregroundStyle(fill?.ink ?? Paper.ink)
      .background(Capsule().fill(fill?.base ?? .clear))
      .overlay(
        Capsule().strokeBorder(fill?.base ?? (hovered && isEnabled ? Paper.ink : Paper.line), lineWidth: 2)
      )
      .opacity(isEnabled ? 1 : 0.4)
      .scaleEffect(pressed ? 0.98 : 1)
      .onHover { hovered = $0 }
  }
}

/// The message, set in Bricolage 800 with the design's tight 0.98 line height
/// and −0.04em tracking, which SwiftUI's Text can't express; selectable.
private struct MessageText: NSViewRepresentable {
  let text: String
  let size: CGFloat

  func makeNSView(context: Context) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: "")
    field.isSelectable = true
    field.drawsBackground = false
    field.isBordered = false
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
  }

  func updateNSView(_ field: NSTextField, context: Context) {
    let font = NSFont(name: Bricolage.extraBoldName, size: size) ?? .systemFont(ofSize: size, weight: .heavy)
    let paragraph = NSMutableParagraphStyle()
    let lineHeight = (size * 0.98).rounded()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    paragraph.lineBreakMode = .byWordWrapping
    field.attributedStringValue = NSAttributedString(
      string: text,
      attributes: [
        .font: font,
        .kern: -0.04 * size,
        .paragraphStyle: paragraph,
        .foregroundColor: NSColor(Paper.ink),
        // Center the glyphs in the tightened line box.
        .baselineOffset: (lineHeight - (font.ascender - font.descender)) / 2,
      ])
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView field: NSTextField, context: Context) -> CGSize? {
    // Lines no wider than about twelve words of this size (docs/design.md).
    let width = min(proposal.width ?? 1000, size * 12)
    field.preferredMaxLayoutWidth = width
    return CGSize(width: width, height: field.fittingSize.height)
  }
}

/// Message size: 156pt for a few words down to 80pt for a paragraph (on a
/// 1440×900 display), then smaller still if the text wouldn't fit the page.
private func fitMessage(_ body: String, in size: CGSize) -> CGFloat {
  let scale = min(1.4, max(0.7, min(size.width / 1440, size.height / 900)))
  let t = min(1, max(0, Double(body.count - 14) / 70))
  let preferred = (156 - 76 * t.squareRoot()) * scale
  // Room for text: the page minus its padding and the reply row.
  let width = size.width - 2 * 40 - 2 * 72
  let height = size.height - 96 - 40 - 2 * 64 - 68 - 40
  // Roughly 0.55em per character and 1em per line, with slack for wrapping.
  let fits = ((width * height) / (Double(max(1, body.count)) * 0.75)).squareRoot()
  return max(36, min(preferred, fits)).rounded()
}
