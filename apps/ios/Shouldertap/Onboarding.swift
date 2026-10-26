import ShouldertapCore
import SwiftUI

// First run, account first (docs/onboarding.md, "The flow"): Welcome →
// Email → Code → You (only without a profile) → Notifications (only if not
// asked yet) → Home. An invite link opened before signing in starts with who
// invited you, runs the same steps, then accepts and celebrates.

/// Where the flow is. Derived from the account, so a relaunch mid-flow picks
/// up at the right screen.
enum OnboardingStep: Hashable {
  case welcome, email, code, loading, you, notifications, accepting, connected, done
}

/// The whole first run, inside one frame. The caller owns the `Frame`; the
/// flow picks its color.
struct OnboardingFlow: View {
  let account: AccountStore
  let senders: SenderStore
  /// An invite link opened before (or during) onboarding; cleared once used.
  @Binding var invite: String
  /// A sign-in QR code scanned here or opened as a link; redeemed, then cleared.
  @Binding var signInLink: String
  @Binding var color: PersonColor
  let sync: () async -> Void
  /// Finished: the person to tap first, when an invite connected you.
  let onDone: (String?) -> Void

  @State private var started = false
  @State private var forward = true
  @State private var knock = 0
  @State private var email = ""
  /// Nil until checked: whether the system still has to ask about notifications.
  @State private var notificationsUndetermined: Bool?
  @AppStorage("notificationsPrimed") private var primed = false
  @State private var acceptance: Acceptance?
  @State private var acceptError: String?
  @State private var preview: InvitePreview?
  @State private var previewFailed = false
  /// Why the last sign-in QR code didn't work, shown on the Email step.
  @State private var scanError: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var step: OnboardingStep {
    guard account.signedIn else {
      if account.pendingEmail != nil { return .code }
      return started ? .email : .welcome
    }
    guard let me = account.me else { return .loading }
    guard me.profile != nil else { return .you }
    guard let undetermined = notificationsUndetermined else { return .loading }
    if undetermined && !primed { return .notifications }
    if acceptance != nil { return .connected }
    if inviteCode(from: invite) != nil { return .accepting }
    return .done
  }

  var body: some View {
    ZStack {
      if step == .connected, let acceptance {
        ConnectedStep(name: acceptance.person.name, color: acceptance.person.color ?? color) {
          finish(with: acceptance)
        }
        .transition(.opacity.animation(.easeOut(duration: 0.4).delay(0.25)))
      } else {
        VStack(spacing: 0) {
          bar
          ZStack {
            screen
              .id(step)
              .transition(reduceMotion ? .opacity : .step(forward: forward))
          }
          .onPaper()
        }
        .transition(
          reduceMotion
            ? .opacity
            : .asymmetric(insertion: .opacity, removal: .move(edge: .bottom).combined(with: .opacity)))
      }
    }
    .animation(.outExpo(0.55), value: step)
    .task(id: account.me?.profile) {
      guard account.me?.profile != nil else { return }
      notificationsUndetermined = await Receiver.shared.notificationsUndetermined()
    }
    .task(id: invite) { await loadPreview() }
    .onChange(of: signInLink, initial: true) { _, link in
      guard !link.isEmpty else { return }
      signInLink = ""
      // Not tied to this view: finishing onboarding mustn't cancel the sync.
      Task { await signInWithQR(link) }
    }
    .task(id: step) {
      switch step {
      case .loading where account.signedIn && account.me == nil: await account.refresh()
      case .accepting: await accept()
      case .done: onDone(nil)
      default: break
      }
    }
  }

  private var bar: some View {
    FrameBar {
      switch step {
      case .email:
        BackButton { go(forward: false) { started = false } }
      case .code:
        BackButton { go(forward: false) { account.changeEmail() } }
      default:
        Wordmark(knock: knock)
      }
    } trailing: {
      HelpButton(store: senders)
    }
  }

  @ViewBuilder private var screen: some View {
    switch step {
    case .welcome:
      if let preview, inviteCode(from: invite) != nil {
        InvitedStep(preview: preview, color: $color) { go { started = true } }
      } else {
        WelcomeStep(color: $color, knock: $knock, invalidInvite: previewFailed, onInvite: { invite = $0 }) {
          go { started = true }
        }
      }
    case .email:
      EmailStep(account: account, email: $email, color: color, scanError: $scanError) { signInLink = $0 }
    case .code:
      CodeStep(account: account, color: color) { await sync() }
    case .loading, .done:
      LoadingStep(error: account.signedIn && account.me == nil ? account.error : nil) {
        Task { await account.refresh() }
      }
    case .you:
      YouStep(account: account, color: $color) { await sync() }
    case .notifications:
      NotificationsStep(color: color) { allow in
        primed = true
        if allow { await Receiver.shared.requestNotifications() }
      }
    case .accepting:
      AcceptingStep(name: preview?.name, error: acceptError, color: color) {
        acceptError = nil
        Task { await accept() }
      } onSkip: {
        invite = ""
      }
    case .connected:
      EmptyView()
    }
  }

  /// "Scan from your computer", or a shouldertap://qr link: signs in, then
  /// carries on exactly as after a correct emailed code (You when there's no
  /// profile, Notifications, sync). A code that didn't work shows on Email.
  private func signInWithQR(_ link: String) async {
    guard !account.signedIn else { return }
    scanError = nil
    if !started { go { started = true } }
    if await account.signIn(scanned: link, platform: .iphone) {
      await sync()
    } else {
      scanError = account.error
    }
  }

  private func loadPreview() async {
    previewFailed = false
    guard inviteCode(from: invite) != nil else { preview = nil; return }
    do {
      let loaded = try await account.previewInvite(code: invite)
      preview = loaded
      if !account.signedIn { withAnimation(.outExpo(0.7)) { color = loaded.swatchColor } }
    } catch {
      preview = nil
      previewFailed = true
    }
  }

  private func accept() async {
    guard acceptError == nil, inviteCode(from: invite) != nil else { return }
    do {
      let result = try await account.accept(
        code: invite, platform: .iphone, deviceName: UIDevice.current.name, senders: senders)
      withAnimation(.outExpo(0.8)) {
        acceptance = result
        if let theirs = result.person.color { color = theirs }
      }
    } catch {
      acceptError = error.localizedDescription
    }
  }

  private func finish(with acceptance: Acceptance) {
    let id = acceptance.sender.flatMap { senders.session(id: $0.grant.credentialId)?.id }
    invite = ""
    self.acceptance = nil
    onDone(id)
  }

  /// Set the direction first, so the leaving screen slides the right way,
  /// then move on the next turn of the run loop.
  private func go(forward: Bool = true, _ change: @escaping () -> Void) {
    self.forward = forward
    Task { withAnimation(.outExpo(0.55)) { change() } }
  }
}

// MARK: Welcome

/// The first screen: one promise, and a live-looking tap cycling through
/// people and their colors like the landing page. Each new tap floods the
/// frame with its color and knocks the wordmark.
private struct WelcomeStep: View {
  @Binding var color: PersonColor
  @Binding var knock: Int
  var invalidInvite = false
  /// An invite link pasted here, e.g. one the website copied on the way to
  /// the App Store.
  let onInvite: @MainActor (String) -> Void
  let onStart: () -> Void

  @State private var sample = 0
  /// Whether there's text to paste. Checked without reading it, so iOS
  /// doesn't ask; the system Paste button reads it without asking either.
  @State private var canPaste = false
  @State private var pastedNonInvite = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let samples: [(name: String, color: PersonColor, message: String)] = [
    ("Mom", .cobalt, "Dinner's ready"),
    ("Sam", .tomato, "Can you get the door?"),
    ("Ari", .moss, "Call me when you're free"),
    ("Jo", .plum, "Leaving in 5"),
  ]

  var body: some View {
    let current = Self.samples[sample]
    Page {
      VStack(alignment: .leading, spacing: 14) {
        Text("A tap on the shoulder, wherever they are")
          .font(Bricolage.extraBold(42))
          .tracking(-1.5)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
          .arrive()
        Text("Your people see it right away and answer with a touch.")
          .font(Bricolage.medium(17))
          .foregroundStyle(Paper.tone)
          .arrive(after: 0.08)
      }
      .padding(.top, 16)

      TapPreview(name: current.name, color: current.color, message: current.message, replies: true)
        .arrive(after: 0.2)

      if invalidInvite {
        Text("That invite has expired or was already used. Ask for a new one once you're set up.")
          .font(Bricolage.medium(15))
          .foregroundStyle(Paper.tone)
      } else if canPaste {
        VStack(alignment: .leading, spacing: 10) {
          Text(
            pastedNonInvite
              ? "That doesn't look like a Shouldertap invite link."
              : "Got an invite link? Paste it to accept."
          )
          .font(Bricolage.medium(15))
          .foregroundStyle(Paper.tone)
          PasteButton(payloadType: String.self) { [onInvite] strings in
            let link = strings.first { inviteCode(from: $0) != nil }
            Task { @MainActor in
              if let link { onInvite(link) } else { pastedNonInvite = true }
            }
          }
          .buttonBorderShape(.capsule)
          .tint(Paper.ink)
          .accessibilityIdentifier("welcome-paste-invite")
        }
        .arrive(after: 0.28)
      }
    } actions: {
      Button("Get started", action: onStart)
        .buttonStyle(PillStyle(color: color))
        .accessibilityIdentifier("welcome-start")
        .arrive(after: 0.32)
      Button("I have an account", action: onStart)
        .buttonStyle(QuietStyle())
        .accessibilityIdentifier("welcome-account")
        .arrive(after: 0.4)
    }
    .onAppear {
      color = current.color
      canPaste = UIPasteboard.general.hasStrings || UIPasteboard.general.hasURLs
    }
    .task {
      // The first knock once the screen has settled.
      guard (try? await Task.sleep(for: .seconds(0.7))) != nil else { return }
      knock += 1
      guard !reduceMotion else { return }
      while (try? await Task.sleep(for: .seconds(3.2))) != nil {
        withAnimation(.outExpo(0.7)) {
          sample = (sample + 1) % Self.samples.count
          color = Self.samples[sample].color
        }
        knock += 1
      }
    }
  }
}

/// Opened from someone's invite link: who it's from, in their color.
private struct InvitedStep: View {
  let preview: InvitePreview
  @Binding var color: PersonColor
  let onAccept: () -> Void

  var body: some View {
    Page {
      Text("\(preview.name) invited you to Shouldertap")
        .font(Bricolage.extraBold(42))
        .tracking(-1.5)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .padding(.top, 16)
        .arrive()
      Text("Accept to tap each other on the shoulder. Taps from \(preview.name) look like this.")
        .font(Bricolage.medium(17))
        .foregroundStyle(Paper.tone)
        .arrive(after: 0.08)
      TapPreview(name: preview.name, color: preview.swatchColor, message: "Got a minute?", replies: true)
        .arrive(after: 0.2)
    } actions: {
      Button("Accept", action: onAccept)
        .buttonStyle(PillStyle(color: preview.swatchColor))
        .accessibilityIdentifier("invite-accept")
        .arrive(after: 0.32)
    }
    .onAppear { color = preview.swatchColor }
  }
}

// MARK: Email and code

private struct EmailStep: View {
  let account: AccountStore
  @Binding var email: String
  let color: PersonColor
  @Binding var scanError: String?
  /// "Scan from your computer" read a sign-in QR code.
  let onScanned: (String) -> Void
  @FocusState private var focused: Bool
  @State private var scanning = false
  @State private var scanned: String?

  private var valid: Bool {
    let value = email.trimmingCharacters(in: .whitespaces)
    return value.contains("@") && value.contains(".")
  }

  var body: some View {
    Page {
      StepHeader(title: "What's your email?", text: "We'll send you a six-digit code. No password to remember.")
      TextField("you@example.com", text: $email)
        .textContentType(.emailAddress)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.send)
        .focused($focused)
        .onSubmit(send)
        .accessibilityIdentifier("email-field")
        .field()
      if let error = account.error ?? scanError {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }
    } actions: {
      Button(action: send) {
        if account.busy { ProgressView().tint(color.ink) } else { Text("Send code") }
      }
      .buttonStyle(PillStyle(color: color))
      .disabled(!valid || account.busy)
      .accessibilityIdentifier("send-code")
      Button {
        focused = false
        scanError = nil
        scanning = true
      } label: {
        Label("Scan from your computer", systemImage: "qrcode.viewfinder")
      }
      .buttonStyle(QuietStyle())
      .disabled(account.busy)
      .accessibilityIdentifier("scan-sign-in")
    }
    .onAppear {
      account.error = nil
      focused = true
    }
    .fullScreenCover(
      isPresented: $scanning,
      onDismiss: {
        if let scanned { onScanned(scanned) }
        scanned = nil
      }
    ) {
      ScanScreen(color: color, copy: .signIn, accepts: { qrSignInToken(from: $0) != nil }) { value in
        scanned = value
        scanning = false
      }
    }
  }

  private func send() {
    guard valid else { return }
    scanError = nil
    Task { await account.sendCode(email: email) }
  }
}

/// Six digits, typed or offered by the keyboard from Mail. The sixth digit
/// submits on its own.
private struct CodeStep: View {
  let account: AccountStore
  let color: PersonColor
  let onSignedIn: () async -> Void

  @State private var code = ""
  @State private var resent = false
  @FocusState private var focused: Bool

  var body: some View {
    Page {
      StepHeader(
        title: "Enter the code",
        text: "We sent it to \(account.pendingEmail ?? "your email"). It works for 10 minutes.")
      ZStack {
        HStack(spacing: 8) {
          ForEach(0..<6, id: \.self) { index in box(index) }
        }
        .accessibilityHidden(true)
        TextField("", text: $code)
          .textContentType(.oneTimeCode)
          .keyboardType(.numberPad)
          .focused($focused)
          .foregroundStyle(.clear)
          .tint(.clear)
          .frame(maxWidth: .infinity, minHeight: 64)
          .contentShape(Rectangle())
          .accessibilityLabel("Six-digit code")
          .accessibilityIdentifier("code-field")
          .onChange(of: code) { _, value in
            let digits = String(value.filter(\.isNumber).prefix(6))
            if digits != value { code = digits; return }
            if digits.count == 6 { submit(digits) }
          }
      }
      .onTapGesture { focused = true }
      if let error = account.error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      } else if resent {
        Text("Sent a new code.").font(Bricolage.medium(15)).foregroundStyle(Paper.tone)
      }
    } actions: {
      if account.busy {
        ProgressView().frame(minHeight: 52)
      }
      HStack(spacing: 8) {
        Button("Resend") {
          code = ""
          Task { resent = await account.sendCode(email: account.pendingEmail ?? "") }
        }
        .buttonStyle(PillStyle())
        .accessibilityIdentifier("resend-code")
        Button("Change email") { withAnimation(.outExpo(0.55)) { account.changeEmail() } }
          .buttonStyle(PillStyle())
          .accessibilityIdentifier("change-email")
      }
      .disabled(account.busy)
    }
    .onAppear {
      account.error = nil
      focused = true
    }
  }

  private func box(_ index: Int) -> some View {
    let characters = Array(code)
    let digit = index < characters.count ? String(characters[index]) : ""
    let current = focused && index == min(characters.count, 5)
    return Text(digit)
      .font(Bricolage.extraBold(30).monospacedDigit())
      .frame(maxWidth: .infinity, minHeight: 64)
      .background(Paper.faint, in: .rect(cornerRadius: 16, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(current ? color.base : .clear, lineWidth: 2)
      }
      .animation(.easeOut(duration: 0.15), value: current)
  }

  private func submit(_ digits: String) {
    resent = false
    Task {
      if await account.verify(code: digits) {
        await onSignedIn()
      } else {
        code = ""
      }
    }
  }
}

// MARK: You

/// Name and color, asked once: how everyone you connect with sees you.
private struct YouStep: View {
  let account: AccountStore
  @Binding var color: PersonColor
  let onSaved: () async -> Void

  @State private var name: String
  @FocusState private var nameFocused: Bool

  init(account: AccountStore, color: Binding<PersonColor>, onSaved: @escaping () async -> Void) {
    self.account = account
    _color = color
    self.onSaved = onSaved
    _name = State(initialValue: account.me?.suggestedName ?? "")
  }

  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    Page {
      StepHeader(title: "How should people see you?", text: "Your name and color frame every tap you send.")

      VStack(alignment: .leading, spacing: 8) {
        Text("Your name").font(Bricolage.bold(14, relativeTo: .subheadline))
        TextField("e.g. Sam", text: $name)
          .textContentType(.givenName)
          .submitLabel(.done)
          .focused($nameFocused)
          .onChange(of: name) { _, value in
            if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
          }
          .accessibilityIdentifier("name-field")
          .field()
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Your color").font(Bricolage.bold(14, relativeTo: .subheadline))
        ColorGrid(color: $color)
      }

      TapPreview(name: trimmedName.isEmpty ? "You" : trimmedName, color: color, message: "Dinner's ready")

      if let error = account.error {
        Text(error).font(Bricolage.medium(15)).foregroundStyle(.red)
      }
    } actions: {
      Button {
        nameFocused = false
        Task { if await account.saveProfile(name: trimmedName, color: color) { await onSaved() } }
      } label: {
        if account.busy { ProgressView().tint(color.ink) } else { Text("Continue") }
      }
      .buttonStyle(PillStyle(color: color))
      .disabled(trimmedName.isEmpty || account.busy)
      .accessibilityIdentifier("profile-continue")
    }
    .onAppear {
      account.error = nil
      if name.isEmpty { nameFocused = true }
    }
  }
}

/// The eight person colors, four to a row.
struct ColorGrid: View {
  @Binding var color: PersonColor

  var body: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 10) {
      ForEach(PersonColor.allCases, id: \.self) { option in
        Button {
          withAnimation(.easeInOut(duration: 0.3)) { color = option }
        } label: {
          Circle()
            .fill(option.base)
            .overlay {
              if option == color {
                IconView(icon: .onIt, size: 22).foregroundStyle(option.ink)
              }
            }
            .overlay(Circle().strokeBorder(Paper.ink.opacity(option == color ? 0.9 : 0), lineWidth: 2).padding(-4))
            .frame(height: 48)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(option == color ? .isSelected : [])
        .accessibilityIdentifier("color-\(option.rawValue)")
      }
    }
    .sensoryFeedback(.selection, trigger: color)
  }
}

// MARK: Notifications

/// Why to allow notifications, before the system asks.
private struct NotificationsStep: View {
  let color: PersonColor
  let onChoice: (Bool) async -> Void
  @State private var pending = false

  var body: some View {
    Page {
      StepHeader(
        title: "Know when someone taps you",
        text: "Taps arrive on your Lock Screen and in the Dynamic Island, and you can answer right there. You'll also hear when someone answers yours.")
      TapPreview(name: "Mom", color: .cobalt, message: "Dinner's ready", replies: true)
    } actions: {
      Button {
        choose(true)
      } label: {
        if pending { ProgressView().tint(color.ink) } else { Text("Turn on notifications") }
      }
      .buttonStyle(PillStyle(color: color))
      .disabled(pending)
      .accessibilityIdentifier("notifications-allow")
      Button("Not now") { choose(false) }
        .buttonStyle(QuietStyle())
        .disabled(pending)
        .accessibilityIdentifier("notifications-skip")
    }
  }

  private func choose(_ allow: Bool) {
    pending = true
    Task {
      await onChoice(allow)
      pending = false
    }
  }
}

// MARK: Waiting

private struct LoadingStep: View {
  let error: String?
  let onRetry: () -> Void

  var body: some View {
    Page {
      VStack(spacing: 16) {
        if let error {
          Text(error).font(Bricolage.medium(17)).foregroundStyle(Paper.tone).multilineTextAlignment(.center)
          Button("Try again", action: onRetry).buttonStyle(PillStyle(small: true))
        } else {
          ProgressView()
        }
      }
      .frame(maxWidth: .infinity, minHeight: 240)
    }
  }
}

/// Accepting the invite that started the flow.
struct AcceptingStep: View {
  let name: String?
  let error: String?
  let color: PersonColor
  let onRetry: () -> Void
  let onSkip: () -> Void

  var body: some View {
    Page {
      if let error {
        StepHeader(title: "Couldn't connect you", text: error)
      } else {
        StepHeader(title: "Connecting you\(name.map { " and \($0)" } ?? "")…", text: "This takes a moment.")
        ProgressView().frame(maxWidth: .infinity)
      }
    } actions: {
      if error != nil {
        Button("Try again", action: onRetry)
          .buttonStyle(PillStyle(color: color))
        Button("Skip for now", action: onSkip)
          .buttonStyle(QuietStyle())
      }
    }
  }
}

// MARK: Connected

/// The page has dropped away and the whole screen is their color. The mark
/// lands big and knocks twice (with a haptic per knock), then keeps knocking
/// now and then.
struct ConnectedStep: View {
  let name: String
  let color: PersonColor
  let onDone: () -> Void

  @State private var shown = false
  @State private var knock = 0
  @State private var thud = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 24)
      MarkView(size: 148, knock: knock)
        .scaleEffect(shown || reduceMotion ? 1 : 0.4)
        .rotationEffect(.degrees(shown || reduceMotion ? 0 : -14))
        .opacity(shown ? 1 : 0)
      VStack(spacing: 12) {
        Text("You and \(name) are connected")
          .font(Bricolage.extraBold(44))
          .tracking(-1.8)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Text("You can tap each other now. Their answers appear here.")
          .font(Bricolage.medium(17))
          .multilineTextAlignment(.center)
          .opacity(0.78)
      }
      .padding(.top, 36)
      .arrive(after: 1.0)
      Spacer(minLength: 24)
      Button("Send your first tap", action: onDone)
        .buttonStyle(PillStyle(color: color, inverted: true))
        .accessibilityIdentifier("connected-done")
        .arrive(after: 1.3)
    }
    .foregroundStyle(color.ink)
    .padding(.horizontal, 28)
    .padding(.bottom, 12)
    .sensoryFeedback(.impact(weight: .heavy, intensity: 0.9), trigger: thud)
    .task {
      guard (try? await Task.sleep(for: .seconds(0.25))) != nil else { return }
      withAnimation(.spring(duration: 0.6, bounce: 0.45)) { shown = true }
      guard (try? await Task.sleep(for: .seconds(0.35))) != nil else { return }
      // Knock, knock: the mark pops twice; a thud lands with each.
      knock += 1
      thud += 1
      guard (try? await Task.sleep(for: .seconds(0.45))) != nil else { return }
      thud += 1
      while (try? await Task.sleep(for: .seconds(3.5))) != nil {
        knock += 1
      }
    }
  }
}

// MARK: Pieces

struct StepHeader: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(Bricolage.extraBold(34))
        .tracking(-1.2)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      Text(text)
        .font(Bricolage.medium(17))
        .foregroundStyle(Paper.tone)
    }
  }
}

/// How a tap looks on someone's screen: the sender's color as the frame,
/// their name on its edge, and (optionally) the answers.
struct TapPreview: View {
  let name: String
  let color: PersonColor
  let message: String
  var replies = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(name)
        .font(Bricolage.bold(13))
        .foregroundStyle(color.ink)
        .padding(.horizontal, 6)
        .contentTransition(.opacity)
      VStack(alignment: .leading, spacing: 14) {
        ZStack(alignment: .leading) {
          Text(message)
            .font(Bricolage.extraBold(26))
            .tracking(-1)
            .id(message)
            .transition(reduceMotion ? .opacity : .rise)
        }
        .frame(maxWidth: .infinity, minHeight: replies ? 0 : 44, alignment: .leading)
        if replies {
          HStack(spacing: 6) {
            reply("On it", icon: .onIt, filled: true)
            reply("In 10 min", icon: .in10)
            reply("Reply", icon: .reply)
          }
        }
      }
      .padding(14)
      .background(Paper.paper, in: .rect(cornerRadius: 14, style: .continuous))
      .foregroundStyle(Paper.ink)
    }
    .padding(8)
    .background(color.base, in: .rect(cornerRadius: 20, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Preview of a tap from \(name): \(message)")
  }

  private func reply(_ label: String, icon: Icon, filled: Bool = false) -> some View {
    HStack(spacing: 4) {
      IconView(icon: icon, size: 13)
      Text(label).lineLimit(1)
    }
    .font(Bricolage.bold(12))
    .padding(.horizontal, 10)
    .frame(height: 28)
    .foregroundStyle(filled ? color.ink : Paper.ink)
    .background {
      if filled {
        Capsule().fill(color.base)
      } else {
        Capsule().strokeBorder(Paper.line, lineWidth: 1.5)
      }
    }
  }
}
