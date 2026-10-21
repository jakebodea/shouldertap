import AppKit
import ShouldertapCore
import SwiftUI

/// The Appearance window, opened from the menu: pick how taps look on this
/// inbox's computers, with a live preview drawn by the real overlay views.
/// Settings live on the server, so every computer follows the change.
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
  @State private var previewing: TapTheme
  @State private var senderId: String?
  @State private var model: OverlayModel
  @State private var busy = false
  @State private var error: String?
  @State private var systemReduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

  init(store: ReceiverStore) {
    self.store = store
    let shown = store.themeOnScreen()
    _previewing = State(initialValue: shown)
    let reduce = store.appearance.reducesMotion(
      systemSetting: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    let model = OverlayModel(
      active: ActiveTap(tap: Self.sample(store: store, senderId: nil), queued: 1), theme: shown, reduceMotion: reduce,
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
        Text("Only you choose this. People who tap you can't change it, and it never changes what they see.")
          .font(.system(size: 12)).foregroundStyle(.secondary)
      }
      preview
      senders
      themes
      decision
      Divider()
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
    .onChange(of: previewing) { syncPreview() }
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
      .accessibilityLabel("Preview of a tap in \(previewing.label)")
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

  private var themes: some View {
    HStack(spacing: 8) {
      ForEach(TapTheme.allCases, id: \.self) { theme in
        Button { previewing = theme } label: {
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
              Text(theme.label).font(.system(size: 13, weight: .semibold))
              Spacer(minLength: 0)
              if theme == store.themeOnScreen() {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(liveGreen)
                  .accessibilityLabel("On your screens")
              }
            }
            Text(Self.subtitle(theme)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
          }
          .padding(.horizontal, 10).padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
          .overlay(
            RoundedRectangle(cornerRadius: 8)
              .strokeBorder(previewing == theme ? Color.primary : Color(nsColor: .separatorColor), lineWidth: previewing == theme ? 1.5 : 0.5))
          .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(previewing == theme ? .isSelected : [])
      }
    }
  }

  /// What choosing the previewed theme takes, said once, plainly.
  @ViewBuilder private var decision: some View {
    let appearance = store.appearance
    let onScreen = store.themeOnScreen()
    VStack(alignment: .leading, spacing: 8) {
      if previewing == onScreen {
        Label("On your screens", systemImage: "checkmark").font(.system(size: 13, weight: .medium))
          .foregroundStyle(.secondary)
      } else if previewing == .default || appearance.canChooseTheme {
        Button(busy ? "Saving…" : "Use \(previewing.label)") { save(theme: previewing) }
          .buttonStyle(.borderedProminent)
          .disabled(busy || !store.appearanceSupported)
      } else {
        Text("Themes other than Default come with patron support while it's active. Default and everything else stay free.")
          .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) {
          if store.patron?.canSubscribe == true {
            Button("Become a patron · $24/year…") { openBilling(manage: false) }.disabled(busy)
          } else if store.patron?.canManage == true {
            Button("Manage support…") { openBilling(manage: true) }.disabled(busy)
          }
        }
      }
      if appearance.theme != .default, onScreen == .default {
        Text(
          "\(appearance.theme.label) is saved and comes back while patron support is active. Until then your screens show Default."
        )
        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
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
    model.active = ActiveTap(tap: Self.sample(store: store, senderId: senderId), queued: 1)
    model.theme = previewing
    model.reduceMotion = store.appearance.reducesMotion(systemSetting: systemReduceMotion)
    model.replying = false
    model.reply = ""
    model.arrival += 1
  }

  private func save(theme: TapTheme? = nil, motion: MotionPreference? = nil) {
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do { try await store.updateAppearance(theme: theme, motion: motion) } catch {
        self.error = error.localizedDescription
      }
    }
  }

  private func openBilling(manage: Bool) {
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do { NSWorkspace.shared.open(try await manage ? store.managePatronURL() : store.checkoutURL()) } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// A tap from someone who can tap you, with their latest message, or a
  /// sample when nobody has yet.
  private static func sample(store: ReceiverStore, senderId: String?) -> Tap {
    let people = store.credentials.filter { $0.kind == .sender }
    let person = people.first { $0.id == senderId } ?? people.first
    let latest = store.taps.first { $0.senderId == person?.id }
    return Tap(
      id: "preview-\(person?.id ?? "sample")", senderId: person?.id ?? "sample", senderName: person?.name ?? "Maya",
      senderColor: person?.swatchColor ?? .moss,
      body: latest?.body ?? "Dinner's ready. Come down whenever you hit a stopping point.",
      createdAt: Date.now.timeIntervalSince1970 * 1000 - 120_000)
  }

  private static func subtitle(_ theme: TapTheme) -> String {
    switch theme {
    case .default: "The calm Frame · free"
    case .broadsheet: "Front-page serif"
    case .billboard: "Poster in their color"
    case .terminal: "Phosphor console"
    case .note: "Handwritten, taped down"
    }
  }
}
