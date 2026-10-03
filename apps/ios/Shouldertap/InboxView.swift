import CoreImage.CIFilterBuiltins
import ShouldertapCore
import SwiftUI

// Your own Shouldertap, on this iPhone: the Inbox tab. Linked to the inbox
// with a device code from the Mac (`ReceiverStore`, `platform: .iphone`), the
// phone gets your taps too (Receiving.swift) and manages the inbox like the
// Mac menu does: invite people, remove them, see your devices and what has
// come in.

/// What screens elsewhere can ask the root for: open your inbox, link this
/// iPhone, or note that an unlink is this phone's own doing.
struct InboxActions {
  var open: () -> Void = {}
  var link: () -> Void = {}
  var unlinking: () -> Void = {}
}

extension EnvironmentValues {
  @Entry var inboxActions = InboxActions()
}

/// Your inbox's frame: graphite, so it never reads as someone you tap.
let inboxColor = PersonColor.graphite

/// The device code inside whatever was scanned or pasted: the Mac's
/// `shouldertap://link#<code>` QR, or the bare code. Invite links to tap
/// someone (`/join`) are refused: redeeming one here would use it up.
func linkCode(from input: String) -> String? {
  let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
  if let url = URL(string: trimmed), url.scheme != nil {
    guard url.host() == "link" || url.path() == "/link" else { return nil }
  }
  return inviteCode(from: trimmed)
}

/// True for links meant for tapping someone, so the link screen can say so.
private func isSenderInvite(_ input: String) -> Bool {
  guard let url = URL(string: input.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme != nil else {
    return false
  }
  return url.host() == "join" || url.path() == "/join"
}

// MARK: The inbox

/// The Mac menu's ready view, on a page: plan, invite, people, devices,
/// recent taps.
struct InboxScreen: View {
  let inbox: ReceiverStore
  let senders: SenderStore

  @State private var removing: Credential?
  @State private var error: String?
  @Environment(\.inboxActions) private var actions

  var body: some View {
    VStack(spacing: 0) {
      FrameBar {
        Wordmark()
      } trailing: {
        HelpButton(store: senders)
      }
      Page {
        header
        InviteCard(inbox: inbox)
        recent
        people
        devices
      }
      .onPaper()
    }
    .confirmationDialog(
      removing.map(removeTitle) ?? "",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible,
      presenting: removing
    ) { credential in
      Button(isSelf(credential) ? "Unlink" : "Remove", role: .destructive) { remove(credential) }
    } message: { credential in
      Text(removeMessage(credential))
    }
    .alert(
      "Couldn't remove", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(error ?? "")
    }
    .onAppear { inbox.refresh() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(inbox.recipientName.isEmpty ? "Your Shouldertap" : "Taps for \(inbox.recipientName)")
        .font(Bricolage.extraBold(34))
        .tracking(-1.2)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      HStack(spacing: 12) {
        StatusLabel(status: inbox.status)
        if let plan = planText {
          Text(plan)
            .font(Bricolage.bold(13, relativeTo: .caption))
            .foregroundStyle(Paper.tone)
        }
      }
    }
  }

  /// Status only: buying happens on the Mac.
  private var planText: String? {
    guard let plan = inbox.plan else { return nil }
    switch plan.currentStatus() {
    case .paid: return "Unlocked"
    case .trial:
      let days = plan.daysLeft()
      return "Trial · \(days) \(days == 1 ? "day" : "days") left"
    case .expired: return "Trial ended · taps are paused"
    }
  }

  private var people: some View {
    let senders = inbox.credentials.filter { $0.kind == .sender }
    return InboxSection(title: "Can tap you") {
      if senders.isEmpty {
        Muted("No one yet. Invite someone above.")
      } else {
        ForEach(senders) { credential in
          CredentialRow(credential: credential, isSelf: false) { removing = credential }
        }
      }
    }
  }

  private var devices: some View {
    InboxSection(title: "Your devices") {
      ForEach(inbox.credentials.filter { $0.kind == .device }) { credential in
        CredentialRow(credential: credential, isSelf: isSelf(credential)) { removing = credential }
      }
      AddMac(inbox: inbox)
    }
  }

  private var recent: some View {
    InboxSection(title: "Recent") {
      if inbox.taps.isEmpty {
        Muted("Taps you receive show up here.")
      } else {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          VStack(spacing: 0) {
            ForEach(inbox.taps.prefix(8)) { tap in
              ReceivedTapRow(tap: tap, now: context.date)
            }
          }
        }
      }
    }
  }

  private func isSelf(_ credential: Credential) -> Bool { credential.id == inbox.credentialId }

  private func removeTitle(_ credential: Credential) -> String {
    isSelf(credential) ? "Unlink this iPhone?" : "Remove \(credential.name)?"
  }

  private func removeMessage(_ credential: Credential) -> String {
    if isSelf(credential) {
      return "It stops managing \(inbox.recipientName.isEmpty ? "your" : "\(inbox.recipientName)'s") Shouldertap. Your Macs keep getting taps, and you can link it again from your Mac."
    }
    if credential.kind == .sender {
      return "Their taps stop reaching you. To tap you again, they'll need a new invite."
    }
    return credential.devicePlatform == .mac
      ? "Taps stop showing up on it. To add it back, you'll need a new code."
      : "It stops managing your Shouldertap. To add it back, you'll need a new code."
  }

  private func remove(_ credential: Credential) {
    if isSelf(credential) { actions.unlinking() }
    Task {
      do {
        try await inbox.revoke(credentialId: credential.id)
      } catch {
        self.error = (error as? APIError)?.message ?? error.localizedDescription
      }
    }
  }
}

// MARK: Inviting

/// Invite someone: a QR code to scan in person, or the link to send. Each
/// works once and lasts 7 days, like the Mac's.
private struct InviteCard: View {
  let inbox: ReceiverStore
  @State private var invite: SenderInvite?
  @State private var pending = false
  @State private var copied = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let invite {
        VStack(spacing: 16) {
          if let qr = qrImage(invite.url.absoluteString) {
            Image(uiImage: qr)
              .interpolation(.none)
              .resizable()
              .frame(width: 184, height: 184)
              .padding(10)
              .background(.white, in: .rect(cornerRadius: 14, style: .continuous))
              .accessibilityLabel("QR code for the invite link")
          }
          Text("Have them scan this with their iPhone camera, or send them the link. It works once and expires in 7 days.")
            .font(Bricolage.medium(15))
            .foregroundStyle(Paper.tone)
            .multilineTextAlignment(.center)
          HStack(spacing: 10) {
            ShareLink(item: invite.url, message: Text("Here's your invite to tap me on Shouldertap. It works once.")) {
              Label("Send link", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(PillStyle(color: inboxColor, small: true))
            .accessibilityIdentifier("share-invite")
            Button {
              UIPasteboard.general.url = invite.url
              copied = true
            } label: {
              Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(PillStyle(small: true))
            .sensoryFeedback(.success, trigger: copied)
          }
          Button("Done") {
            withAnimation(.outExpo(0.4)) { self.invite = nil }
            copied = false
          }
          .buttonStyle(QuietStyle())
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(Paper.faint, in: .rect(cornerRadius: 20, style: .continuous))
        .transition(.opacity.combined(with: .scale(scale: 0.97)))
      } else {
        Button(action: create) {
          if pending {
            ProgressView().tint(inboxColor.ink)
          } else {
            Label { Text("Invite someone") } icon: { IconView(icon: .invite, size: 20) }
          }
        }
        .buttonStyle(PillStyle(color: inboxColor))
        .disabled(pending)
        .accessibilityIdentifier("invite-someone")
      }
      if let error {
        Text(error).font(Bricolage.medium(14)).foregroundStyle(.red)
      }
    }
  }

  private func create() {
    pending = true
    error = nil
    Task {
      defer { pending = false }
      do {
        let created = try await inbox.createSenderInvite()
        withAnimation(.outExpo(0.5)) { invite = created }
      } catch {
        self.error = (error as? APIError)?.message ?? error.localizedDescription
      }
    }
  }
}

/// A code for another Mac to paste, sent from here (AirDrop reaches the Mac).
private struct AddMac: View {
  let inbox: ReceiverStore
  @State private var code: String?
  @State private var copied = false
  @State private var error: String?

  var body: some View {
    if let code {
      VStack(alignment: .leading, spacing: 12) {
        Text("On the other Mac, open Shouldertap and paste this code under Already set up on another Mac. It expires in 15 minutes.")
          .font(Bricolage.medium(15))
          .foregroundStyle(Paper.tone)
        Text(code)
          .font(.system(size: 13, design: .monospaced))
          .textSelection(.enabled)
          .lineLimit(3)
        HStack(spacing: 10) {
          ShareLink(item: code) {
            Label("Send code", systemImage: "square.and.arrow.up")
          }
          .buttonStyle(PillStyle(color: inboxColor, small: true))
          Button {
            UIPasteboard.general.string = code
            copied = true
          } label: {
            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
          }
          .buttonStyle(PillStyle(small: true))
          .sensoryFeedback(.success, trigger: copied)
          Spacer(minLength: 0)
          Button("Done") {
            self.code = nil
            copied = false
          }
          .font(Bricolage.bold(15))
        }
      }
      .padding(16)
      .background(Paper.faint, in: .rect(cornerRadius: 18, style: .continuous))
      .padding(.top, 8)
    } else {
      Button {
        error = nil
        Task {
          do { code = try await inbox.createDeviceCode().code } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
          }
        }
      } label: {
        HStack(spacing: 12) {
          IconView(icon: .addMac, size: 20)
            .frame(width: 40, height: 40)
            .background(Paper.faint, in: .circle)
          Text("Add a Mac").font(Bricolage.bold(17))
          Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("add-mac")
      if let error {
        Text(error).font(Bricolage.medium(14)).foregroundStyle(.red)
      }
    }
  }
}

// MARK: Rows

private struct InboxSection<Content: View>: View {
  let title: String
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title)
        .font(Bricolage.bold(14, relativeTo: .subheadline))
        .foregroundStyle(Paper.tone)
        .padding(.bottom, 4)
        .accessibilityAddTraits(.isHeader)
      content
    }
  }
}

private struct Muted: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text)
      .font(Bricolage.medium(15))
      .foregroundStyle(Paper.tone)
      .padding(.vertical, 8)
  }
}

/// A sender (their initial in their color) or a device (its glyph), with a
/// menu to remove it.
private struct CredentialRow: View {
  let credential: Credential
  let isSelf: Bool
  let onRemove: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      if credential.kind == .sender {
        Avatar(name: credential.name, color: credential.swatchColor)
      } else {
        IconView(icon: credential.devicePlatform == .iphone ? .phone : .mac, size: 20)
          .frame(width: 40, height: 40)
          .background(Paper.faint, in: .circle)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(credential.name).font(Bricolage.bold(17)).lineLimit(1)
        Text(status).font(Bricolage.medium(14)).foregroundStyle(Paper.tone)
      }
      Spacer(minLength: 0)
      Menu {
        Button(isSelf ? "Unlink this iPhone" : "Remove \(credential.name)", systemImage: "minus.circle", role: .destructive, action: onRemove)
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 17, weight: .semibold))
          .frame(width: 40, height: 40)
          .contentShape(Rectangle())
      }
      .foregroundStyle(Paper.tone)
      .accessibilityLabel("Options for \(credential.name)")
    }
    .padding(.vertical, 8)
    .accessibilityIdentifier("credential-\(credential.name)")
  }

  private var status: String {
    if isSelf { return "This iPhone" }
    let seen = credential.lastSeenAt.map { "Active \(relativeTime($0))" } ?? "Paired"
    guard credential.kind == .device else { return seen }
    return credential.devicePlatform == .iphone ? "iPhone · \(seen)" : seen
  }
}

/// A tap you got: who, what, and how it was answered.
private struct ReceivedTapRow: View {
  let tap: Tap
  let now: Date

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Avatar(name: tap.senderName, color: tap.senderColor, size: 32)
      VStack(alignment: .leading, spacing: 4) {
        Text(tap.body)
          .font(Bricolage.bold(17))
          .fixedSize(horizontal: false, vertical: true)
        Text("\(tap.senderName) · \(answer) · \(relativeTime(tap.createdAt, now: now))")
          .font(Bricolage.medium(14).monospacedDigit())
          .foregroundStyle(Paper.tone)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 10)
    .accessibilityElement(children: .combine)
  }

  private var answer: String {
    guard tap.state == .acknowledged else { return "Waiting for you" }
    let label = tap.response?.label ?? "Answered"
    return tap.acknowledgedBy.map { "\(label) on \($0)" } ?? label
  }
}

/// A crisp QR image for `text`; scale it with `.interpolation(.none)`.
private func qrImage(_ text: String) -> UIImage? {
  let filter = CIFilter.qrCodeGenerator()
  filter.message = Data(text.utf8)
  filter.correctionLevel = "M"
  guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
    let image = CIContext().createCGImage(output, from: output.extent)
  else { return nil }
  return UIImage(cgImage: image)
}

// MARK: Linking

/// Link this iPhone to your Mac: open Shouldertap on the Mac, Add a Mac or
/// iPhone, and scan its code (or paste it). A scanned code links right away.
struct LinkCover: View {
  let inbox: ReceiverStore
  var code: String = ""
  /// nil in the Inbox tab, where there's nothing to close.
  var onClose: (() -> Void)?
  let onLinked: () -> Void

  @State private var text: String
  @State private var scanning = false
  @State private var scanned: String?
  @State private var pending = false
  @State private var error: String?

  init(inbox: ReceiverStore, code: String = "", onClose: (() -> Void)? = nil, onLinked: @escaping () -> Void) {
    self.inbox = inbox
    self.code = code
    self.onClose = onClose
    self.onLinked = onLinked
    _text = State(initialValue: code)
  }

  private var parsed: String? { linkCode(from: text) }

  var body: some View {
    Frame(color: inboxColor) {
      VStack(spacing: 0) {
        FrameBar {
          Wordmark()
        } trailing: {
          if let onClose {
            Button(action: onClose) { IconView(icon: .close, size: 18) }
              .buttonStyle(FrameButtonStyle(iconOnly: true))
              .accessibilityLabel("Close")
              .accessibilityIdentifier("link-close")
          }
        }
        Page {
          StepHeader(
            title: "Get your taps here too",
            text: "Link this iPhone to Shouldertap on your Mac. Taps then reach both, and you can answer on either. From here you can also invite people and remove them.")

          NumberedSteps(color: inboxColor, steps: [
            "Click the Shouldertap mark in your Mac's menu bar.",
            "Under Your Macs or Your devices, click Add another Mac (or Add a Mac or iPhone). A code appears.",
            "Scan its QR code with this iPhone, or copy the code and paste it below.",
          ])

          VStack(alignment: .leading, spacing: 8) {
            Text("Or paste the code").font(Bricolage.bold(14, relativeTo: .subheadline))
            HStack(spacing: 8) {
              TextField("Code from your Mac", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { if parsed != nil { link(text) } }
                .accessibilityIdentifier("link-field")
                .field()
              PasteButton(payloadType: String.self) { strings in
                guard let first = strings.first else { return }
                text = first
              }
              .labelStyle(.iconOnly)
              .buttonBorderShape(.capsule)
              .tint(inboxColor.base)
            }
            if let message = fieldMessage {
              Text(message).font(Bricolage.medium(14)).foregroundStyle(.red)
            }
          }
        } actions: {
          if parsed != nil {
            Button {
              link(text)
            } label: {
              if pending { ProgressView().tint(inboxColor.ink) } else { Text("Link") }
            }
            .buttonStyle(PillStyle(color: inboxColor))
            .disabled(pending)
            .accessibilityIdentifier("link-button")
          } else {
            Button {
              scanning = true
            } label: {
              Label("Scan QR code", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(PillStyle(color: inboxColor))
            .accessibilityIdentifier("link-scan")
          }
        }
        .onPaper()
      }
    }
    .fullScreenCover(
      isPresented: $scanning,
      onDismiss: {
        if let scanned { link(scanned) }
        scanned = nil
      }
    ) {
      LinkScanScreen { value in
        scanned = value
        scanning = false
      }
    }
  }

  private var fieldMessage: String? {
    if let error { return error }
    guard !text.isEmpty, parsed == nil else { return nil }
    return isSenderInvite(text)
      ? "That's an invite to tap someone. To link your Mac, use the code under Your devices."
      : "That doesn't look like a code from your Mac."
  }

  private func link(_ value: String) {
    guard let code = linkCode(from: value), !pending else { return }
    text = value
    pending = true
    error = nil
    Task {
      defer { pending = false }
      do {
        try await inbox.join(code: code)
        onLinked()
      } catch let failure as APIError where failure.code != .network {
        error = failure.message
      } catch {
        self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
      }
    }
  }
}

/// The camera, taking only the Mac's link code (`shouldertap://link#…`).
private struct LinkScanScreen: View {
  let onCode: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Frame(color: inboxColor) {
      VStack(spacing: 0) {
        FrameBar {
          Text("Scan your Mac's code").font(Bricolage.extraBold(19)).tracking(-0.6)
        } trailing: {
          Button { dismiss() } label: { IconView(icon: .close, size: 18) }
            .buttonStyle(FrameButtonStyle(iconOnly: true))
            .accessibilityLabel("Close")
        }
        VStack(alignment: .leading, spacing: 16) {
          QRScanner { value in
            guard URL(string: value)?.scheme != nil, linkCode(from: value) != nil else { return false }
            onCode(value)
            return true
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 22)
        .padding(.top, 22)
        .onPaper()
      }
    }
  }
}
