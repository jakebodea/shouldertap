import AppKit
import ShouldertapCore
import SwiftUI

/// The Appearance window, opened from the menu. People who tap you choose how
/// their own taps look (a patron benefit of theirs); here you see that with a
/// live preview drawn by the real overlay views, and keep the free controls:
/// show their styles or always plain, and motion. Settings live on the
/// server, so every computer follows the change.
@MainActor
final class AppearanceController {
  private let store: ReceiverStore
  private var window: NSWindow?

  init(store: ReceiverStore) { self.store = store }

  func show() {
    if window == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 760, height: 720), styleMask: [.titled, .closable, .miniaturizable],
        backing: .buffered, defer: false)
      window.title = "Tap Appearance"
      window.isReleasedWhenClosed = false
      window.contentView = NSHostingView(rootView: AppearanceView(store: store))
      window.center()
      self.window = window
    }
    store.refresh()
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

struct AppearanceView: View {
  let store: ReceiverStore
  @State private var senderId: String?
  @State private var model: OverlayModel
  @State private var busy = false
  @State private var error: String?
  @State private var systemReduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

  init(store: ReceiverStore) {
    self.store = store
    let reduce = store.appearance.reducesMotion(
      systemSetting: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    let sample = Self.sample(store: store, senderId: nil)
    let model = OverlayModel(
      active: ActiveTap(tap: sample, queued: 1), theme: store.theme(for: sample), reduceMotion: reduce,
      respond: { _, _ in })
    // Answering the preview sends nothing; it plays the arrival again.
    model.respond = { [weak model] _, _ in
      model?.replying = false
      model?.reply = ""
      model?.arrival += 1
    }
    _model = State(initialValue: model)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text("How taps look on your computers").font(.system(size: 17, weight: .semibold))
        Text(
          "People who tap you can send their taps in a style of their choosing. You never pay to see it, and you can always show every tap plain."
        )
        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      preview
      senders
      Divider()
      senderThemes
      motion
      if !store.appearanceSupported {
        Text("This server doesn't support appearance settings yet. Taps show in Default.")
          .font(.system(size: 12)).foregroundStyle(.secondary)
      }
      if let error {
        Text(error).font(.system(size: 12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(22)
    .frame(width: 760)
    .onAppear(perform: syncPreview)
    .onChange(of: senderId) { syncPreview() }
    .onChange(of: store.appearance) { syncPreview() }
    .onReceive(
      NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification)
    ) { _ in
      systemReduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      syncPreview()
    }
  }

  // MARK: Preview

  /// The real overlay at a 1440×900 display, scaled into the window.
  private var preview: some View {
    let width: CGFloat = 716
    let scale = width / 1440
    return OverlayView(model: model)
      .frame(width: 1440, height: 900)
      .scaleEffect(scale, anchor: .topLeading)
      .frame(width: width, height: 900 * scale, alignment: .topLeading)
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator, lineWidth: 0.5))
      .shadow(color: .black.opacity(0.18), radius: 10, y: 6)
      .accessibilityLabel("Preview of a tap in \(model.theme.label)")
  }

  private var senders: some View {
    let people = store.credentials.filter { $0.kind == .sender }
    return HStack(spacing: 8) {
      if !people.isEmpty {
        Text("Preview as").font(.system(size: 12)).foregroundStyle(.secondary)
        ForEach(people) { person in
          let selected = (senderId ?? people.first?.id) == person.id
          Button { senderId = person.id } label: {
            Circle().fill(person.swatchColor.base)
              .frame(width: 22, height: 22)
              .overlay(
                Text(person.name.prefix(1).uppercased()).font(Bricolage.bold(11)).foregroundStyle(person.swatchColor.ink))
              .padding(3)
              .overlay(Circle().strokeBorder(selected ? Color.primary : .clear, lineWidth: 1.5))
          }
          .buttonStyle(.plain)
          .help(person.name)
          .accessibilityLabel("Preview a tap from \(person.name)")
          .accessibilityAddTraits(selected ? .isSelected : [])
        }
      }
      Spacer()
      Button {
        model.reply = ""
        model.replying = false
        model.arrival += 1
      } label: {
        Label("Replay", systemImage: "arrow.counterclockwise")
      }
      .keyboardShortcut("r", modifiers: .command)
    }
  }

  /// The free override: every sender's style, or every tap plain.
  private var senderThemes: some View {
    VStack(alignment: .leading, spacing: 6) {
      Picker(
        "Senders' styles",
        selection: Binding(get: { store.appearance.senderThemes }, set: { save(senderThemes: $0) })
      ) {
        Text("Show their styles").tag(SenderThemePreference.show)
        Text("Always plain").tag(SenderThemePreference.plain)
      }
      .pickerStyle(.segmented)
      .frame(width: 320)
      .disabled(busy || !store.appearanceSupported)
      Text(
        store.appearance.senderThemes == .plain
          ? "Every tap shows in Default, whoever sent it."
          : "Each tap shows in the style its sender chose. Answering works the same in every style."
      )
      .font(.system(size: 12)).foregroundStyle(.secondary)
    }
  }

  private var motion: some View {
    VStack(alignment: .leading, spacing: 6) {
      Picker(
        "Motion",
        selection: Binding(get: { store.appearance.motion }, set: { save(motion: $0) })
      ) {
        Text("Follow system").tag(MotionPreference.system)
        Text("Always reduce").tag(MotionPreference.reduced)
      }
      .pickerStyle(.segmented)
      .frame(width: 320)
      .disabled(busy || !store.appearanceSupported)
      Text(
        systemReduceMotion
          ? "Reduce Motion is on in System Settings, so taps fade in calmly."
          : "Arrivals settle in about a second. Always reduce makes them a short fade on every computer."
      )
      .font(.system(size: 12)).foregroundStyle(.secondary)
    }
  }

  // MARK: Actions

  private func syncPreview() {
    let sample = Self.sample(store: store, senderId: senderId)
    model.active = ActiveTap(tap: sample, queued: 1)
    model.theme = store.theme(for: sample)
    model.reduceMotion = store.appearance.reducesMotion(systemSetting: systemReduceMotion)
    model.replying = false
    model.reply = ""
    model.arrival += 1
  }

  private func save(motion: MotionPreference? = nil, senderThemes: SenderThemePreference? = nil) {
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do { try await store.updateAppearance(motion: motion, senderThemes: senderThemes) } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// A tap from someone who can tap you, with their latest message in the
  /// theme they sent it with, or a sample when nobody has yet.
  private static func sample(store: ReceiverStore, senderId: String?) -> Tap {
    let people = store.credentials.filter { $0.kind == .sender }
    let person = people.first { $0.id == senderId } ?? people.first
    let latest = store.taps.first { $0.senderId == person?.id }
    return Tap(
      id: "preview-\(person?.id ?? "sample")", senderId: person?.id ?? "sample", senderName: person?.name ?? "Maya",
      senderColor: person?.swatchColor ?? .moss,
      body: latest?.body ?? "Dinner's ready. Come down whenever you hit a stopping point.",
      createdAt: Date.now.timeIntervalSince1970 * 1000 - 120_000, theme: latest?.theme)
  }
}
