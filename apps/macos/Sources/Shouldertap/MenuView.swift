import AppKit
import ServiceManagement
import ShouldertapCore
import SwiftUI

/// The menu bar popover: a native surface, so system font and colors, with
/// Bricolage only in the "Shouldertap" title (docs/design.md, "Surfaces").
struct MenuView: View {
  let store: ReceiverStore
  let senders: SenderStore
  let updates: Updates
  let account: AccountStore
  let openAppearance: () -> Void
  let openAccount: () -> Void
  /// nil opens the invite form.
  let openSend: (String?) -> Void
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        #if DEBUG
          DebugBanner()
        #endif
        switch store.phase {
        case .loading: ProgressView().frame(maxWidth: .infinity, minHeight: 120)
        case .setup: SetupView(store: store, senders: senders, updates: updates, openAccount: openAccount, openSend: openSend)
        case .ready:
          ReadyView(
            store: store, senders: senders, updates: updates, account: account, openAppearance: openAppearance,
            openAccount: openAccount, openSend: openSend)
        }
      }
      .padding(14)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    // Grow with the content, and scroll past 620pt.
    .frame(width: 380, height: min(max(contentHeight, 120), 620))
  }
}

#if DEBUG
  /// Says which build and server this is, so a debug build is never taken
  /// for the installed app.
  private struct DebugBanner: View {
    var body: some View {
      Text("DEBUG BUILD · \(Config.endpoints.server.host(percentEncoded: false) ?? "?"):\(Config.endpoints.server.port.map(String.init) ?? "")")
        .font(.system(size: 11, weight: .bold, design: .monospaced))
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 5)
        .background(.orange, in: RoundedRectangle(cornerRadius: 6))
    }
  }
#endif

// MARK: Screens

private struct SetupView: View {
  let store: ReceiverStore
  let senders: SenderStore
  let updates: Updates
  let openAccount: () -> Void
  let openSend: (String?) -> Void
  @State private var name = ""
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Brand(subtitle: "Welcome")
      Muted(
        "People you trust can tap you on the shoulder. Their message covers your screens until you answer, and they see your reply right away."
      )

      Section(title: "Set up this Mac") {
        TextField("Your first name, as senders will see it", text: $name)
          .textFieldStyle(.roundedBorder)
          .onSubmit(createInbox)
          .onChange(of: name) { _, value in
            if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
          }
        MenuButton(title: "Get started", kind: .primary, action: createInbox)
          .disabled(busy || trimmed(name).isEmpty)
      }

      Section(title: "Already set up on another computer?") {
        TextField("Paste the pairing code from your other computer", text: $code)
          .textFieldStyle(.roundedBorder)
        MenuButton(title: "Pair this Mac", icon: .addMac, action: join)
          .disabled(busy || trimmed(code).isEmpty)
      }

      YouCanTap(senders: senders, openSend: openSend)

      MenuButton(title: "Restore with email", kind: .plain, action: openAccount)

      if let error { ErrorText(error) }
      if busy { ProgressView().controlSize(.small).frame(maxWidth: .infinity) }
      Footer(updates: updates)
    }
  }

  private func createInbox() {
    let value = trimmed(name)
    guard !value.isEmpty else { return }
    run { try await store.createInbox(recipientName: value) }
  }

  private func join() {
    run { try await store.join(code: code) }
  }

  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    busy = true
    error = nil
    Task {
      do { try await action() } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

private struct ReadyView: View {
  let store: ReceiverStore
  let senders: SenderStore
  let updates: Updates
  let account: AccountStore
  let openAppearance: () -> Void
  let openAccount: () -> Void
  let openSend: (String?) -> Void

  var body: some View {
    let senders = store.credentials.filter { $0.kind == .sender }
    let devices = store.credentials.filter { $0.kind == .device }
    VStack(alignment: .leading, spacing: 16) {
      Brand(subtitle: subtitle) {
        StatusLabel(status: store.status)
      }

      InviteSender(store: store)

      Section(title: "Can tap you") {
        if senders.isEmpty {
          Muted("No one yet. Invite someone above.")
        } else {
          ForEach(senders) { PairingRow(store: store, credential: $0, isSelf: false) }
        }
      }

      YouCanTap(senders: self.senders, openSend: openSend)

      Section(title: "Your devices") {
        ForEach(devices) { PairingRow(store: store, credential: $0, isSelf: $0.id == store.credentialId) }
        AddDevice(store: store)
      }

      Section(title: "Accessibility") {
        Row(action: openAppearance) { _ in
          Text("Tap motion").font(.system(size: 13, weight: .medium))
          Spacer(minLength: 0)
          Text(appearanceLabel).font(.system(size: 12)).foregroundStyle(.secondary)
          Text("›").font(.system(size: 13)).foregroundStyle(.tertiary)
        }
        .accessibilityLabel("Tap motion, \(appearanceLabel)")
      }

      Section(title: "Account") {
        Row(action: openAccount) { _ in
          Text("Account and recovery").font(.system(size: 13, weight: .medium))
          Spacer(minLength: 0)
          Text(accountLabel).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
          Text("›").font(.system(size: 13)).foregroundStyle(.tertiary)
        }
        .accessibilityLabel("Account and recovery, \(accountLabel)")
      }

      Section(title: "Recent") {
        if store.taps.isEmpty {
          Muted("Taps you receive show up here.")
        } else {
          ForEach(store.taps.prefix(6)) { TapRow(store: store, tap: $0) }
        }
      }

      PatronView(store: store)
      Footer(updates: updates)
    }
  }

  private var accountLabel: String {
    account.signedIn ? (account.email ?? "Signed in") : "Not signed in"
  }

  private var appearanceLabel: String {
    store.appearance.motion == .reduced ? "Reduced" : "Follow system"
  }

  /// Billing never changes the recipient name or messaging controls.
  private var subtitle: String {
    guard !store.recipientName.isEmpty else { return " " }
    let base = "Taps for \(store.recipientName)"
    return base
  }
}

/// The other direction: people this Mac can tap, each opening the composer.
private struct YouCanTap: View {
  let senders: SenderStore
  let openSend: (String?) -> Void

  var body: some View {
    Section(title: "You can tap") {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        VStack(alignment: .leading, spacing: 8) {
          ForEach(senders.sessions) { person in
            Row(action: { openSend(person.id) }) { _ in
              Avatar(name: person.pairing.recipientName, color: person.color)
              VStack(alignment: .leading, spacing: 1) {
                Text(person.pairing.recipientName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(latestSummary(person, now: context.date))
                  .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
              }
              Spacer(minLength: 0)
              Text("›").font(.system(size: 13)).foregroundStyle(.tertiary)
            }
            .accessibilityLabel("Tap \(person.pairing.recipientName)")
          }
        }
      }
      Row(action: { openSend(nil) }) { _ in
        Glyph(icon: .send)
        Text(senders.sessions.isEmpty ? "Got an invite? Tap someone" : "Add someone")
          .font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
      }
    }
  }
}

// MARK: Optional support

private struct PatronView: View {
  let store: ReceiverStore
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    DisclosureGroup("Patron themes") {
      VStack(alignment: .leading, spacing: 8) {
        Muted("Shouldertap is free to receive and answer. Patron support belongs to the people who tap you: it lets them send their taps in a style, to everyone they tap. You never pay to see it.")
        if store.patron?.legacySupporter == true { Muted("Thank you for your original purchase. It is preserved; you have not been enrolled in a subscription.") }
        // Support bought from this computer before it moved to senders:
        // still manageable and cancelable here, never sold here again.
        if let patron = store.patron, patron.canManage {
          if patron.active, let until = patron.paidUntil {
            Muted("Your earlier support from this computer is paid through \(Date(timeIntervalSince1970: until / 1000).formatted(date: .abbreviated, time: .omitted)).")
          }
          MenuButton(title: busy ? "Opening…" : "Manage or cancel earlier support", kind: .secondary, fullWidth: true) { open() }.disabled(busy)
        }
        if let error { ErrorText(error) }
      }.padding(.top, 8)
    }.font(.system(size: 12))
  }

  private func open() {
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do { NSWorkspace.shared.open(try await store.managePatronURL()) } catch { self.error = error.localizedDescription }
    }
  }
}

// MARK: Pieces

private struct Brand<Trailing: View>: View {
  let subtitle: String
  @ViewBuilder var trailing: Trailing

  init(subtitle: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
    self.subtitle = subtitle
    self.trailing = trailing()
  }

  var body: some View {
    HStack(spacing: 10) {
      MarkView().frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        Text("Shouldertap").font(Bricolage.bold(16)).tracking(-0.32)
        Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 0)
      trailing
    }
  }
}

private struct StatusLabel: View {
  let status: LiveStatus

  var body: some View {
    let (label, color): (String, Color) =
      switch status {
      case .live: ("Connected", liveGreen)
      case .connecting: ("Connecting…", .orange)
      case .offline: ("Offline", Color(nsColor: .tertiaryLabelColor))
      }
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(label).font(.system(size: 12)).foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }
}

private struct InviteSender: View {
  let store: ReceiverStore
  @State private var invite: SenderInvite?
  @State private var copied = false
  @State private var error: String?

  var body: some View {
    if let invite {
      Card {
        if let qr = QRCode.image(for: invite.url.absoluteString) {
          Image(nsImage: qr)
            .interpolation(.none)
            .resizable()
            .frame(width: 176, height: 176)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("QR code for the invite link")
        }
        Muted("Scan with their iPhone camera, or send them the link to open on their phone or computer. It works once and expires in 7 days.")
          .multilineTextAlignment(.center)
        Mono(invite.url.absoluteString, lines: 2)
        HStack(spacing: 8) {
          MenuButton(title: copied ? "Copied" : "Copy link", icon: .copy, kind: .primary) {
            copyToClipboard(invite.url.absoluteString)
            copied = true
          }
          MenuButton(title: "Done", kind: .plain) {
            self.invite = nil
            copied = false
          }
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 8) {
        MenuButton(title: "Invite someone", icon: .invite, kind: .primary, fullWidth: true) {
          error = nil
          Task {
            do { invite = try await store.createSenderInvite() } catch { self.error = error.localizedDescription }
          }
        }
        if let error { ErrorText(error) }
      }
    }
  }
}

/// Another Mac or PC pastes the code; an iPhone scans the QR code, which opens
/// Shouldertap on it (`shouldertap://link#<code>`, the code in the fragment
/// like invite links).
private struct AddDevice: View {
  let store: ReceiverStore
  @State private var code: String?
  @State private var copied = false
  @State private var error: String?

  var body: some View {
    if let code {
      Card {
        if let qr = QRCode.image(for: "shouldertap://link#\(code)") {
          Image(nsImage: qr)
            .interpolation(.none)
            .resizable()
            .frame(width: 148, height: 148)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("QR code to link your iPhone")
        }
        Muted(
          "Scan with your iPhone's camera to link it, or paste the code into Shouldertap on another Mac or PC. It works once and expires in 15 minutes."
        )
        .multilineTextAlignment(.center)
        Mono(code, lines: 3)
        HStack(spacing: 8) {
          MenuButton(title: copied ? "Copied" : "Copy code", icon: .copy, kind: .primary) {
            copyToClipboard(code)
            copied = true
          }
          MenuButton(title: "Done", kind: .plain) {
            self.code = nil
            copied = false
          }
        }
      }
      .padding(.top, 4)
    } else {
      Row(action: {
        error = nil
        Task {
          do { code = try await store.createDeviceCode().code } catch { self.error = error.localizedDescription }
        }
      }) { _ in
        Glyph(icon: .addMac)
        Text("Add a Mac, PC or iPhone").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
      }
      if let error { ErrorText(error) }
    }
  }
}

private struct PairingRow: View {
  let store: ReceiverStore
  let credential: Credential
  let isSelf: Bool
  @State private var confirming = false
  @State private var error: String?

  var body: some View {
    Row { hovered in
      if credential.kind == .sender {
        Avatar(name: credential.name, color: credential.swatchColor)
      } else {
        // Hugeicons' computer stands for a Windows PC too.
        Glyph(icon: credential.devicePlatform == .iphone ? .phone : .mac)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(credential.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        Text(error ?? status).font(.system(size: 12)).foregroundStyle(error == nil ? .secondary : Color.red)
      }
      Spacer(minLength: 0)
      if confirming {
        HStack(spacing: 8) {
          MenuButton(title: isSelf ? "Unpair" : "Remove", kind: .danger) {
            Task {
              do { try await store.revoke(credentialId: credential.id) } catch {
                self.error = error.localizedDescription
                confirming = false
              }
            }
          }
          MenuButton(title: "Cancel", kind: .plain) { confirming = false }
        }
      } else {
        Button { confirming = true } label: {
          IconView(icon: .remove, size: 16).frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(hovered ? 1 : 0)
        .accessibilityLabel("Remove \(credential.name)")
      }
    }
  }

  private var status: String {
    if isSelf { return "This Mac" }
    let seen = credential.lastSeenAt.map { "Active \(ago($0))" } ?? "Paired"
    guard credential.kind == .device else { return seen }
    switch credential.devicePlatform {
    case .iphone: return "iPhone · \(seen)"
    case .windows: return "Windows PC · \(seen)"
    case .mac: return seen
    }
  }
}

/// A tap you got, with a delete button on hover that asks once more.
private struct TapRow: View {
  let store: ReceiverStore
  let tap: Tap
  @State private var confirming = false
  @State private var error: String?

  var body: some View {
    Row(alignment: .top) { hovered in
      Avatar(name: tap.senderName, color: tap.senderColor)
      VStack(alignment: .leading, spacing: 2) {
        Text(tap.body).font(.system(size: 13, weight: .semibold)).lineLimit(2)
        HStack(spacing: 5) {
          if let response = tap.response, error == nil {
            IconView(icon: response.icon, size: 13).foregroundStyle(.secondary)
          }
          Text(error ?? "\(tap.response?.label ?? "Waiting for you") · \(ago(tap.createdAt))")
            .font(.system(size: 12))
            .foregroundStyle(error == nil ? .secondary : Color.red)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      if confirming {
        HStack(spacing: 8) {
          MenuButton(title: "Delete", kind: .danger) {
            Task {
              do { try await store.delete(tapId: tap.id) } catch {
                self.error = error.localizedDescription
                confirming = false
              }
            }
          }
          MenuButton(title: "Cancel", kind: .plain) { confirming = false }
        }
      } else {
        Button {
          error = nil
          confirming = true
        } label: {
          IconView(icon: .remove, size: 16).frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(hovered ? 1 : 0)
        .help("Delete for everyone")
        .accessibilityLabel("Delete this tap")
      }
    }
  }
}

private struct Footer: View {
  let updates: Updates
  @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let version = updates.available {
        Row(action: updates.checkForUpdates) { _ in
          Circle().fill(Color.accentColor).frame(width: 7, height: 7).frame(width: 26)
          Text("Update available: \(version)").font(.system(size: 13, weight: .semibold))
          Spacer(minLength: 0)
          Text("Install").font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(.bottom, 8)
      }
      Divider().padding(.bottom, 12)
      HStack {
        Toggle(isOn: $launchAtLogin) {
          Text("Open at login").font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .onChange(of: launchAtLogin) { _, enabled in
          do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
          } catch {}
          launchAtLogin = SMAppService.mainApp.status == .enabled
        }
        Spacer()
        MenuButton(title: "Check for Updates…", kind: .plain, action: updates.checkForUpdates)
        MenuButton(title: "Quit", kind: .plain) { NSApp.terminate(nil) }
      }
    }
  }
}

// MARK: Building blocks

private struct Section<Content: View>: View {
  let title: String
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 8) { content }
    }
  }
}

private struct Muted: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text).font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(2)
      .fixedSize(horizontal: false, vertical: true)
  }
}

private struct ErrorText: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text).font(.system(size: 12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
  }
}

private struct Mono: View {
  let text: String
  let lines: Int
  init(_ text: String, lines: Int) {
    self.text = text
    self.lines = lines
  }

  var body: some View {
    Text(text)
      .font(.system(size: 11, design: .monospaced))
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .lineLimit(lines)
      .textSelection(.enabled)
  }
}

private struct Card<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 10) { content }
      .padding(12)
      .frame(maxWidth: .infinity)
      .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
  }
}

/// A person: a circle in their color with their initial in its ink.
private struct Avatar: View {
  let name: String
  let color: PersonColor

  var body: some View {
    Circle()
      .fill(color.base)
      .frame(width: 26, height: 26)
      .overlay(
        Text(name.trimmingCharacters(in: .whitespaces).prefix(1).uppercased().nilIfEmpty ?? "?")
          .font(Bricolage.bold(12))
          .foregroundStyle(color.ink)
      )
      .accessibilityHidden(true)
  }
}

private struct Glyph: View {
  let icon: Icon

  var body: some View {
    IconView(icon: icon, size: 18).foregroundStyle(.secondary).frame(width: 26, height: 26)
  }
}

/// A list row that highlights under the pointer; content gets the hover state.
private struct Row<Content: View>: View {
  var alignment: VerticalAlignment = .center
  var action: (() -> Void)?
  @ViewBuilder var content: (Bool) -> Content
  @State private var hovered = false

  var body: some View {
    let row = HStack(alignment: alignment, spacing: 10) { content(hovered) }
      .padding(6)
      .background(
        RoundedRectangle(cornerRadius: 7).fill(hovered ? Color(nsColor: .quaternaryLabelColor) : .clear)
      )
      .padding(.horizontal, -6)
      .contentShape(Rectangle())
      .onHover { hovered = $0 }
    if let action {
      Button(action: action) { row }.buttonStyle(.plain)
    } else {
      row
    }
  }
}

private struct MenuButton: View {
  enum Kind { case primary, secondary, danger, plain }

  let title: String
  var icon: Icon?
  var kind: Kind = .secondary
  var fullWidth = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let icon { IconView(icon: icon, size: 16) }
        Text(title).font(.system(size: 13, weight: kind == .primary ? .semibold : .medium))
      }
      .frame(maxWidth: fullWidth ? .infinity : nil)
    }
    .buttonStyle(MenuButtonStyle(kind: kind))
    // No ring on the first button every time the popover opens; Full
    // Keyboard Access still moves focus through the buttons.
    .focusEffectDisabled()
  }
}

private struct MenuButtonStyle: ButtonStyle {
  let kind: MenuButton.Kind

  func makeBody(configuration: Configuration) -> some View {
    MenuButtonChrome(label: configuration.label, pressed: configuration.isPressed, kind: kind)
  }
}

private struct MenuButtonChrome<Label: View>: View {
  let label: Label
  let pressed: Bool
  let kind: MenuButton.Kind
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let ink = colorScheme == .dark ? Color(hex: 0xf5f5f7) : Color(hex: 0x1d1d1f)
    let onInk = colorScheme == .dark ? Color(hex: 0x1d1d1f) : .white
    label
      .foregroundStyle(foreground(onInk: onInk))
      .padding(.horizontal, kind == .plain ? 4 : 12)
      .frame(minHeight: kind == .plain ? 24 : 32)
      .background(
        RoundedRectangle(cornerRadius: 8)
          .fill(kind == .primary ? ink : kind == .plain ? .clear : Color(nsColor: .controlBackgroundColor))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .strokeBorder(kind == .primary || kind == .plain ? .clear : Color(nsColor: .separatorColor), lineWidth: 0.5)
      )
      .contentShape(RoundedRectangle(cornerRadius: 8))
      .opacity(isEnabled ? (pressed ? 0.7 : 1) : 0.45)
  }

  private func foreground(onInk: Color) -> Color {
    switch kind {
    case .primary: onInk
    case .danger: .red
    case .plain: .secondary
    case .secondary: .primary
    }
  }
}

extension TapResponse {
  var icon: Icon {
    switch kind {
    case .onIt: .onIt
    case .in10: .in10
    case .text: .reply
    }
  }
}

private func trimmed(_ value: String) -> String {
  value.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func copyToClipboard(_ text: String) {
  NSPasteboard.general.clearContents()
  NSPasteboard.general.setString(text, forType: .string)
}

extension String {
  fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
