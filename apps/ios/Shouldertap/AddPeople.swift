import ShouldertapCore
import SwiftUI

// Adding people once you're set up: invite someone with a link or QR code,
// or accept a link someone sent you. Accepting connects you both ways.

/// "Add your people": the Tap tab before anyone is connected, and the cover
/// behind the composer's add button.
struct AddPeople: View {
  let inbox: ReceiverStore
  let color: PersonColor
  /// A link was pasted or scanned: accept it, or (a computer's sign-in code,
  /// scanned) confirm signing that computer in. See `RootView.open(scanned:)`.
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
        // As a cover over the composer it only closes; Settings is a tap away under it.
        if let onClose {
          Button(action: onClose) { IconView(icon: .close, size: 18) }
            .buttonStyle(FrameButtonStyle(iconOnly: true))
            .accessibilityLabel("Close")
            .accessibilityIdentifier("close-button")
        } else {
          SettingsButton()
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
  /// Picked for just this person; nil sends `me.sendProfile`.
  @State private var seenAs: Profile?
  /// Their tap style, saved once you're connected.
  @State private var seenTheme = TapTheme.default
  @State private var choosing = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// How they'll see you unless you change it: the profile you picked last.
  private var sendDefault: Profile? { account.me?.sendProfile ?? account.me?.profile }

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
    .sheet(isPresented: $choosing) {
      if let profile = seenAs ?? sendDefault, let preview {
        SeenAsEditor(
          note: "Only \(preview.name) sees this. Everyone else keeps seeing you as before.",
          saveLabel: "Use for them", initial: profile, theme: seenTheme,
          onCancel: { choosing = false },
          onSave: { picked, theme in
            seenAs = picked
            seenTheme = theme
            choosing = false
          })
      }
    }
  }

  private var page: some View {
    Page {
      if let preview {
        StepHeader(
          title: "\(preview.name) invited you",
          text: "Accept to tap each other on the shoulder. Taps from \(preview.name) look like this.")
        TapPreview(name: preview.name, color: preview.swatchColor, message: "Got a minute?", replies: true)
        if let profile = seenAs ?? sendDefault {
          SeenAsRow(lead: "They'll see you as", profile: profile, theme: seenTheme) { choosing = true }
        }
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
        code: invite, profile: seenAs, platform: .iphone, deviceName: UIDevice.current.name, senders: senders)
      // Accepting takes a name and color; the style follows on the new connection.
      if seenTheme != .default, let id = result.sender?.grant.credentialId,
        let pairing = senders.session(id: id)?.pairing
      {
        try? await account.updateSendProfile(
          id, name: pairing.senderName, color: pairing.swatchColor, theme: seenTheme, senders: senders)
      }
      withAnimation(.outExpo(0.8)) { acceptance = result }
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// An invite link (https://shouldertap.app/join#… or shouldertap://join#…).
nonisolated func isInvite(_ value: String) -> Bool {
  guard let url = URL(string: value), url.path == "/join" || url.host == "join" else { return false }
  return inviteCode(from: value) != nil
}

/// What an in-app scanner takes once you're signed in: an invite, or a
/// computer's "Sign in with your phone" code (docs/onboarding.md).
nonisolated func isInviteOrComputerSignIn(_ value: String) -> Bool {
  isInvite(value) || deviceSignInCode(from: value) != nil
}

/// The camera, over everything in your frame. `accepts` decides which QR
/// codes it takes; any other keeps it scanning.
struct ScanScreen: View {
  let color: PersonColor
  var copy = ScanCopy.invite
  var accepts: (String) -> Bool = isInviteOrComputerSignIn
  let onScan: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Frame(color: color) {
      VStack(spacing: 0) {
        FrameBar {
          Text(copy.title).font(Bricolage.extraBold(19)).tracking(-0.6)
        } trailing: {
          Button { dismiss() } label: { IconView(icon: .close, size: 18) }
            .buttonStyle(FrameButtonStyle(iconOnly: true))
            .accessibilityLabel("Close")
            .accessibilityIdentifier("scan-cancel")
        }
        VStack(alignment: .leading, spacing: 16) {
          QRScanner(copy: copy) { value in
            guard accepts(value) else { return false }
            onScan(value)
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

/// "{lead} ● {name} (in {theme}) · Change": how one person will see you.
struct SeenAsRow: View {
  let lead: String
  let profile: Profile
  var theme = TapTheme.default
  let onChange: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(profile.color.base).frame(width: 12, height: 12)
      Text("\(lead) \(Text(profile.name).bold())\(theme == .default ? "" : " in \(theme.label)")")
        .foregroundStyle(Paper.tone)
      Button("Change", action: onChange)
        .foregroundStyle(Paper.ink)
        .underline()
        .accessibilityIdentifier("seen-as-change")
    }
    .font(Bricolage.medium(15))
  }
}

/// A name, color and tap style for one person only (docs/onboarding.md,
/// "Change how one person sees you"), as a sheet. Mirrors apps/web's
/// seen-as.tsx, plus the themes.
struct SeenAsEditor: View {
  let title: String
  let note: String
  let saveLabel: String
  let cancelLabel: String
  let onCancel: () -> Void
  let onSave: (Profile, TapTheme) async throws -> Void

  @State private var name: String
  @State private var color: PersonColor
  @State private var theme: TapTheme
  @State private var pending = false
  @State private var error: String?
  @FocusState private var nameFocused: Bool

  init(
    title: String = "How they see you", note: String, saveLabel: String, cancelLabel: String = "Cancel",
    initial: Profile, theme: TapTheme, onCancel: @escaping () -> Void,
    onSave: @escaping (Profile, TapTheme) async throws -> Void
  ) {
    self.title = title
    self.note = note
    self.saveLabel = saveLabel
    self.cancelLabel = cancelLabel
    self.onCancel = onCancel
    self.onSave = onSave
    _name = State(initialValue: initial.name)
    _color = State(initialValue: initial.color)
    _theme = State(initialValue: theme)
  }

  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var shownName: String { trimmedName.isEmpty ? "You" : trimmedName }

  var body: some View {
    Page {
      StepHeader(title: title, text: note)

      VStack(alignment: .leading, spacing: 8) {
        Text("Your name").font(Bricolage.bold(14, relativeTo: .subheadline))
        TextField("e.g. Sam", text: $name)
          .submitLabel(.done)
          .focused($nameFocused)
          .onChange(of: name) { _, value in
            if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
          }
          .accessibilityIdentifier("seen-as-name")
          .field()
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Color").font(Bricolage.bold(14, relativeTo: .subheadline))
        ColorGrid(color: $color)
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Tap style").font(Bricolage.bold(14, relativeTo: .subheadline))
        ThemePicker(theme: $theme, name: shownName, color: color)
      }

      SeenAsPreview(theme: theme, name: shownName, color: color)

      if let error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }
    } actions: {
      Button {
        nameFocused = false
        save()
      } label: {
        if pending { ProgressView().tint(color.ink) } else { Text(saveLabel) }
      }
      .buttonStyle(PillStyle(color: color))
      .disabled(trimmedName.isEmpty || pending)
      .accessibilityIdentifier("seen-as-save")
      Button(cancelLabel, action: onCancel)
        .buttonStyle(QuietStyle())
        .disabled(pending)
        .accessibilityIdentifier("seen-as-cancel")
    }
    .sheetOnPaper()
  }

  private func save() {
    guard !pending, !trimmedName.isEmpty else { return }
    pending = true
    error = nil
    let picked = Profile(name: trimmedName, color: color)
    let theme = theme
    Task {
      defer { pending = false }
      do { try await onSave(picked, theme) } catch { self.error = error.localizedDescription }
    }
  }
}
