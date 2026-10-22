import CoreImage.CIFilterBuiltins
import ShouldertapCore
import SwiftUI

// Your own Shouldertap, on this iPhone: the Inbox tab. Signing in gives the
// phone a credential for your inbox (`AccountStore.sync`), so it gets your
// taps too (Receiving.swift) and manages the inbox like the Mac menu does:
// invite people, remove them, see your devices and what has come in.

/// What screens elsewhere can ask the root for: open your inbox, or open Account.
struct InboxActions {
  var open: () -> Void = {}
  var account: () -> Void = {}
}

extension EnvironmentValues {
  @Entry var inboxActions = InboxActions()
}

/// Your inbox's frame: graphite, so it never reads as someone you tap.
let inboxColor = PersonColor.graphite

// MARK: The inbox

/// The Mac menu's ready view, on a page: plan, invite, people, devices,
/// recent taps.
struct InboxScreen: View {
  let inbox: ReceiverStore
  let senders: SenderStore

  @State private var removing: Credential?
  @State private var deleting: Tap?
  @State private var error: String?
  @Environment(\.inboxActions) private var actions

  var body: some View {
    VStack(spacing: 0) {
      FrameBar {
        Wordmark()
      } trailing: {
        HStack(spacing: 6) {
          AccountButton()
          HelpButton(store: senders)
        }
      }
      Page {
        header
        if Receiver.shared.notificationsAllowed == false {
          VStack(alignment: .leading, spacing: 8) {
            Muted("Notifications are off. Open Shouldertap to receive taps, or enable notifications in Settings for background delivery.")
            Button("Notification settings") {
              if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(PillStyle(small: true))
          }
        }
        InviteCard(inbox: inbox, color: inboxColor)
        recent
        people
        devices
        accountRow
        patronSupport
      }
      .onPaper()
    }
    .confirmationDialog(
      removing.map(removeTitle) ?? "",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible,
      presenting: removing
    ) { credential in
      Button("Remove", role: .destructive) { remove(credential) }
    } message: { credential in
      Text(removeMessage(credential))
    }
    .confirmationDialog(
      "Delete this tap?",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible,
      presenting: deleting
    ) { tap in
      Button("Delete", role: .destructive) { delete(tap) }
    } message: { tap in
      Text("It's removed from your history and your devices, and from \(tap.senderName)'s.")
    }
    .alert(
      "Couldn't complete that action", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })
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

  private var planText: String? { "Free" }

  /// Support bought for this inbox before patron support moved to senders.
  @ViewBuilder private var patronSupport: some View {
    if let patron = inbox.patron, patron.active {
      InboxSection(title: "Support Shouldertap") {
        VStack(alignment: .leading, spacing: 12) {
          Text(patron.status == "ending" ? "Thank you. Your support ends after the paid period." : "Thank you for your support.")
          if let until = patron.paidUntil {
            Text("Paid through \(Date(timeIntervalSince1970: until / 1000).formatted(date: .abbreviated, time: .omitted))")
              .foregroundStyle(Paper.tone)
          }
        }
      }
    }
  }

  private var accountRow: some View {
    InboxSection(title: "Account") {
      VStack(alignment: .leading, spacing: 8) {
        Muted(Stores.account.email.map { "Signed in as \($0)." } ?? "Signed in.")
        Button("Manage account", action: actions.account)
          .buttonStyle(PillStyle(small: true))
      }
      .padding(.top, 4)
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
      Muted("Sign in on another iPhone, Mac or PC to get your taps there too.")
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
                .contextMenu {
                  Button("Delete", systemImage: "trash", role: .destructive) { deleting = tap }
                }
            }
          }
        }
      }
    }
  }

  private func delete(_ tap: Tap) {
    Task {
      do {
        try await inbox.delete(tapId: tap.id)
      } catch {
        self.error = (error as? APIError)?.message ?? error.localizedDescription
      }
    }
  }

  private func isSelf(_ credential: Credential) -> Bool { credential.id == inbox.credentialId }

  private func removeTitle(_ credential: Credential) -> String {
    "Remove \(credential.name)?"
  }

  private func removeMessage(_ credential: Credential) -> String {
    if credential.kind == .sender {
      return "Their taps stop reaching you. To tap you again, they'll need a new invite."
    }
    return "Taps stop reaching it until you sign in on it again."
  }

  private func remove(_ credential: Credential) {
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
struct InviteCard: View {
  let inbox: ReceiverStore
  let color: PersonColor
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
            .buttonStyle(PillStyle(color: color, small: true))
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
          .buttonStyle(PillStyle())
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(Paper.faint, in: .rect(cornerRadius: 20, style: .continuous))
        .transition(.opacity.combined(with: .scale(scale: 0.97)))
      } else {
        Button(action: create) {
          if pending || inbox.phase != .ready {
            ProgressView().tint(color.ink)
          } else {
            Label { Text("Invite someone") } icon: { IconView(icon: .invite, size: 20) }
          }
        }
        .buttonStyle(PillStyle(color: color))
        .disabled(pending || inbox.phase != .ready)
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
      if !isSelf {
        Menu {
          Button("Remove \(credential.name)", systemImage: "minus.circle", role: .destructive, action: onRemove)
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 17, weight: .semibold))
            .frame(width: 40, height: 40)
            .contentShape(Rectangle())
        }
        .foregroundStyle(Paper.tone)
        .accessibilityLabel("Options for \(credential.name)")
      }
    }
    .padding(.vertical, 8)
    .accessibilityIdentifier("credential-\(credential.name)")
  }

  private var status: String {
    if isSelf { return "This iPhone" }
    let seen = credential.lastSeenAt.map { "Active \(relativeTime($0))" } ?? "Paired"
    guard credential.kind == .device else { return seen }
    switch credential.devicePlatform {
    case .iphone: return "iPhone · \(seen)"
    case .windows: return "Windows PC · \(seen)"
    case .mac: return seen
    }
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

/// The Inbox tab while this iPhone's inbox credential is on its way from the
/// account (the first sync after signing in).
struct InboxWaiting: View {
  let account: AccountStore
  let senders: SenderStore
  let onRetry: () -> Void

  var body: some View {
    Frame(color: inboxColor) {
      VStack(spacing: 0) {
        FrameBar { Wordmark() } trailing: {
          HStack(spacing: 6) {
            AccountButton()
            HelpButton(store: senders)
          }
        }
        Page {
          StepHeader(title: "Setting up your inbox", text: "Taps for you will arrive here and on your Lock Screen.")
          if let error = account.error {
            Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
            Button("Try again", action: onRetry).buttonStyle(PillStyle(small: true))
          } else {
            ProgressView().frame(maxWidth: .infinity)
          }
        }
        .onPaper()
      }
    }
  }
}
