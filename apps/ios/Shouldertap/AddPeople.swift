import ShouldertapCore
import SwiftUI

// Adding people once you're set up: invite someone with a link or QR code,
// or accept a link someone sent you. Accepting connects you both ways.

/// "Add your people": the Tap tab before anyone is connected, and the cover
/// behind the composer's add button.
struct AddPeople: View {
  let inbox: ReceiverStore
  let senders: SenderStore
  let color: PersonColor
  /// A link was pasted or scanned: accept it.
  let onInvite: (String) -> Void
  var onClose: (() -> Void)?

  @State private var text = ""
  @State private var scanning = false
  @State private var scanned: String?

  private var code: String? { inviteCode(from: text) }

  var body: some View {
    VStack(spacing: 0) {
      FrameBar {
        Wordmark()
      } trailing: {
        HStack(spacing: 6) {
          AccountButton()
          HelpButton(store: senders)
          if let onClose {
            Button(action: onClose) { IconView(icon: .close, size: 18) }
              .buttonStyle(FrameButtonStyle(iconOnly: true))
              .accessibilityLabel("Close")
              .accessibilityIdentifier("close-button")
          }
        }
      }
      Page {
        StepHeader(
          title: "Add your people",
          text: "Invite the people you want to tap. Once they accept, you can tap each other.")

        InviteCard(inbox: inbox, color: color)

        VStack(alignment: .leading, spacing: 8) {
          Text("Got a link? Paste or scan").font(Bricolage.bold(14, relativeTo: .subheadline))
          HStack(spacing: 8) {
            TextField("shouldertap.app/join#…", text: $text)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)
              .submitLabel(.continue)
              .onSubmit { if code != nil { onInvite(text) } }
              .accessibilityIdentifier("invite-field")
              .field()
            PasteButton(payloadType: String.self) { strings in
              guard let first = strings.first else { return }
              text = first
              if inviteCode(from: first) != nil { onInvite(first) }
            }
            .labelStyle(.iconOnly)
            .buttonBorderShape(.capsule)
            .tint(color.base)
          }
          if !text.isEmpty && code == nil {
            Text("That doesn't look like a Shouldertap invite link.")
              .font(Bricolage.medium(14)).foregroundStyle(.red)
          }
          if code != nil {
            Button("Continue") { onInvite(text) }
              .buttonStyle(PillStyle(color: color, small: true))
              .accessibilityIdentifier("invite-continue")
          } else {
            Button {
              scanning = true
            } label: {
              Label("Scan QR code", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(PillStyle(small: true))
            .accessibilityIdentifier("scan-button")
          }
        }
      }
      .onPaper()
    }
    .fullScreenCover(
      isPresented: $scanning,
      onDismiss: {
        if let scanned { onInvite(scanned) }
        scanned = nil
      }
    ) {
      ScanScreen(color: color) { value in
        scanned = value
        scanning = false
      }
    }
  }
}

/// An invite opened once you're set up: who it's from, Accept, then the
/// celebration in their color.
struct AcceptInvite: View {
  let account: AccountStore
  let senders: SenderStore
  let invite: String
  let onCancel: () -> Void
  /// Connected: the person to tap, when this made a new connection.
  let onDone: (String?) -> Void

  @State private var preview: InvitePreview?
  @State private var error: String?
  @State private var pending = false
  @State private var acceptance: Acceptance?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var color: PersonColor {
    acceptance?.person.color ?? preview?.swatchColor ?? account.me?.profile?.color ?? .cobalt
  }

  var body: some View {
    Frame(color: color) {
      ZStack {
        if let acceptance {
          ConnectedStep(name: acceptance.person.name, color: color) {
            onDone(acceptance.sender.flatMap { senders.session(id: $0.grant.credentialId)?.id })
          }
          .transition(.opacity.animation(.easeOut(duration: 0.4).delay(0.25)))
        } else {
          VStack(spacing: 0) {
            FrameBar {
              Wordmark()
            } trailing: {
              Button(action: onCancel) { IconView(icon: .close, size: 18) }
                .buttonStyle(FrameButtonStyle(iconOnly: true))
                .accessibilityLabel("Close")
                .accessibilityIdentifier("close-button")
            }
            page.onPaper()
          }
          .transition(
            reduceMotion
              ? .opacity
              : .asymmetric(insertion: .opacity, removal: .move(edge: .bottom).combined(with: .opacity)))
        }
      }
    }
    .task { await load() }
  }

  private var page: some View {
    Page {
      if let preview {
        StepHeader(
          title: "\(preview.name) invited you",
          text: "Accept to tap each other on the shoulder. Taps from \(preview.name) look like this.")
        TapPreview(name: preview.name, color: preview.swatchColor, message: "Got a minute?", replies: true)
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity, minHeight: 200)
      }
      if let error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }
    } actions: {
      if preview != nil {
        Button {
          Task { await accept() }
        } label: {
          if pending { ProgressView().tint(color.ink) } else { Text("Accept") }
        }
        .buttonStyle(PillStyle(color: color))
        .disabled(pending)
        .accessibilityIdentifier("invite-accept")
      }
    }
  }

  private func load() async {
    do {
      preview = try await account.previewInvite(code: invite)
    } catch {
      self.error = "That invite has expired or was already used. Ask for a new one."
    }
  }

  private func accept() async {
    pending = true
    error = nil
    defer { pending = false }
    do {
      let result = try await account.accept(
        code: invite, platform: .iphone, deviceName: UIDevice.current.name, senders: senders)
      withAnimation(.outExpo(0.8)) { acceptance = result }
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// The camera, over everything in your frame. Takes only invite links
/// (https://shouldertap.app/join#… or shouldertap://join#…); any other QR
/// code keeps it scanning.
struct ScanScreen: View {
  let color: PersonColor
  let onInvite: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Frame(color: color) {
      VStack(spacing: 0) {
        FrameBar {
          Text("Scan their invite").font(Bricolage.extraBold(19)).tracking(-0.6)
        } trailing: {
          Button { dismiss() } label: { IconView(icon: .close, size: 18) }
            .buttonStyle(FrameButtonStyle(iconOnly: true))
            .accessibilityLabel("Close")
            .accessibilityIdentifier("scan-cancel")
        }
        VStack(alignment: .leading, spacing: 16) {
          QRScanner { value in
            guard let url = URL(string: value), url.path == "/join" || url.host == "join",
              inviteCode(from: value) != nil
            else { return false }
            onInvite(value)
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
