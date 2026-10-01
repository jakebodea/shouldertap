import AppKit
import ServiceManagement
import ShouldertapCore
import SwiftUI

/// The menu bar popover: a native surface, so system font and colors, with
/// Bricolage only in the "Shouldertap" title (docs/design.md, "Surfaces").
struct MenuView: View {
  let store: ReceiverStore
  let updates: Updates
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    ScrollView {
      Group {
        switch store.phase {
        case .loading: ProgressView().frame(maxWidth: .infinity, minHeight: 120)
        case .setup: SetupView(store: store, updates: updates)
        case .ready: ReadyView(store: store, updates: updates)
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

// MARK: Screens

private struct SetupView: View {
  let store: ReceiverStore
  let updates: Updates
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

      Section(title: "Already set up on another Mac?") {
        TextField("Paste the pairing code from your other Mac", text: $code)
          .textFieldStyle(.roundedBorder)
        MenuButton(title: "Pair this Mac", icon: .addMac, action: join)
          .disabled(busy || trimmed(code).isEmpty)
      }

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
  let updates: Updates

  var body: some View {
    let senders = store.credentials.filter { $0.kind == .sender }
    let macs = store.credentials.filter { $0.kind == .device }
    VStack(alignment: .leading, spacing: 16) {
      Brand(subtitle: subtitle) {
        StatusLabel(status: store.status)
      }

      if let plan = store.plan, plan.currentStatus() != .paid {
        PlanView(store: store, plan: plan)
      }

      InviteSender(store: store)

      Section(title: "Can tap you") {
        if senders.isEmpty {
          Muted("No one yet. Invite someone above.")
        } else {
          ForEach(senders) { PairingRow(store: store, credential: $0, isSelf: false) }
        }
      }

      Section(title: "Your Macs") {
        ForEach(macs) { PairingRow(store: store, credential: $0, isSelf: $0.id == store.credentialId) }
        AddMac(store: store)
      }

      Section(title: "Recent") {
        if store.taps.isEmpty {
          Muted("Taps you receive show up here.")
        } else {
          ForEach(store.taps.prefix(6)) { TapRow(tap: $0) }
        }
      }

      Footer(updates: updates)
    }
  }

  /// "Taps for Jake", plus a quiet "Unlocked" once paid for.
  private var subtitle: String {
    guard !store.recipientName.isEmpty else { return " " }
    let base = "Taps for \(store.recipientName)"
    return store.plan?.status == .paid ? "\(base) · Unlocked" : base
  }
}

// MARK: Plan

/// The trial and the way out of it. Quiet while the trial has time left,
/// a card in its last 3 days, and the first thing in the menu once it ends.
private struct PlanView: View {
  let store: ReceiverStore
  let plan: Plan
  @State private var busy = false
  @State private var opened = false
  @State private var error: String?
  @State private var notice: String?

  var body: some View {
    let status = plan.currentStatus()
    let days = plan.daysLeft()
    Group {
      if status == .expired {
        Card {
          VStack(alignment: .leading, spacing: 4) {
            Text("Your trial ended — taps are paused")
              .font(.system(size: 13, weight: .semibold))
            Muted("Unlock Shouldertap for a one-time $5. People who can tap you get through again right away.")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          unlockButton(kind: .primary)
          messages
        }
      } else if days <= 3 {
        Card {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Circle().fill(.orange).frame(width: 7, height: 7)
              Text(days == 1 ? "Last day of your trial" : "Trial · \(days) days left")
                .font(.system(size: 13, weight: .semibold))
            }
            .accessibilityElement(children: .combine)
            Muted("Taps pause when the trial ends. Unlock for good with a one-time $5.")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          unlockButton(kind: .secondary)
          messages
        }
      } else {
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text("Trial · \(days) days left").font(.system(size: 12)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if busy { ProgressView().controlSize(.mini) }
            MenuButton(title: "Unlock for $5", kind: .plain, action: unlock).disabled(busy)
          }
          messages
        }
      }
    }
  }

  private func unlockButton(kind: MenuButton.Kind) -> some View {
    MenuButton(title: busy ? "Opening checkout…" : "Unlock for $5", kind: kind, fullWidth: true, action: unlock)
      .disabled(busy)
  }

  @ViewBuilder private var messages: some View {
    if let error {
      ErrorText(error).frame(maxWidth: .infinity, alignment: .leading)
    } else if let notice {
      Muted(notice).frame(maxWidth: .infinity, alignment: .leading)
    } else if opened {
      Muted("Finish checking out in your browser. This updates on its own once you've paid.")
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func unlock() {
    busy = true
    error = nil
    notice = nil
    Task {
      do {
        NSWorkspace.shared.open(try await store.checkoutURL())
        opened = true
      } catch let failure as APIError where failure.code == .conflict {
        // Already paid: the store refreshes the plan, so say so quietly.
        notice = failure.message
      } catch {
        self.error = error.localizedDescription
      }
      busy = false
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
        Muted("Scan with their iPhone camera, or send them the link. It works once and expires in 7 days.")
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

private struct AddMac: View {
  let store: ReceiverStore
  @State private var code: String?
  @State private var copied = false
  @State private var error: String?

  var body: some View {
    if let code {
      Card {
        Muted("On your other Mac, open Shouldertap and paste this code. It expires in 15 minutes.")
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
        Text("Add another Mac").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
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
        Glyph(icon: .mac)
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
    return credential.lastSeenAt.map { "Active \(ago($0))" } ?? "Paired"
  }
}

private struct TapRow: View {
  let tap: Tap

  var body: some View {
    Row(alignment: .top) { _ in
      Avatar(name: tap.senderName, color: tap.senderColor)
      VStack(alignment: .leading, spacing: 2) {
        Text(tap.body).font(.system(size: 13, weight: .semibold)).lineLimit(2)
        HStack(spacing: 5) {
          if let response = tap.response {
            IconView(icon: response.icon, size: 13).foregroundStyle(.secondary)
          }
          Text("\(tap.response?.label ?? "Waiting for you") · \(ago(tap.createdAt))")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
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
