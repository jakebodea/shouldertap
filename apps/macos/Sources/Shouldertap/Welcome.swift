import AppKit
import ShouldertapCore
import SwiftUI

/// The first run (docs/onboarding.md, "The flow"): a centered window framed
/// in Cobalt, while the real menu bar icon knocks.
/// Welcome → email → code → you (name and color, once) → ready. Shown on
/// first launch, and again from the menu until this Mac is signed in.
@MainActor
final class WelcomeController: NSObject, NSWindowDelegate {
  private static let seenKey = "welcomeSeen"
  static let size = NSSize(width: 860, height: 600)

  /// Not seen yet. Debug builds show it every launch with SHOULDERTAP_WELCOME=1.
  static var shouldShow: Bool {
    #if DEBUG
      if ProcessInfo.processInfo.environment["SHOULDERTAP_WELCOME"] != nil { return true }
    #endif
    return !UserDefaults.standard.bool(forKey: seenKey)
  }

  private var window: NSWindow?
  private var model: WelcomeModel?
  private var finished: ((_ setUp: Bool) -> Void)?

  var isShowing: Bool { window != nil }

  /// `finished` runs once the welcome is dismissed, `setUp` true when the
  /// menu should open next.
  func show(
    account: AccountStore, sync: @escaping @MainActor () async -> Void,
    finished: @escaping (_ setUp: Bool) -> Void
  ) {
    guard window == nil else { return }
    self.finished = finished
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: Self.size),
      styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    // An empty unified toolbar makes the title bar as tall as the band, so the
    // traffic lights line up with the wordmark.
    window.toolbar = NSToolbar()
    window.toolbarStyle = .unified
    window.title = "Welcome to Shouldertap"
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.delegate = self
    let model = WelcomeModel(
      account: account, sync: sync,
      dismiss: { [weak self] setUp in self?.dismiss(setUp: setUp) })
    window.contentView = Self.host(model)
    window.setContentSize(Self.size)
    self.model = model
    window.center()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    self.window = window
  }

  /// The welcome's view, on paper and at the window's size: the window sets
  /// the size and the view fills it, title bar included. Snapshots use it too.
  static func host(_ model: WelcomeModel) -> NSView {
    let host = PaperHostingView(rootView: WelcomeView(model: model))
    host.sizingOptions = []
    host.frame = NSRect(origin: .zero, size: size)
    return host
  }

  /// The menu bar icon, clicked while it's up: on the last step that's
  /// "Open the menu"; before that it would throw away a sign-in halfway
  /// through, so it only brings the window forward.
  func statusItemClicked() {
    if model?.step == .ready { dismiss(setUp: true) } else { focus() }
  }

  /// Launched again while it's up: bring it forward.
  func focus() {
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }

  /// The close button is Later.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    dismiss(setUp: false)
    return false
  }

  /// Leaves with the overlay's 420ms fade.
  func dismiss(setUp: Bool) {
    guard let window else { return }
    self.window = nil
    model = nil
    UserDefaults.standard.set(true, forKey: Self.seenKey)
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.42
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.2, 1)
      window.animator().alphaValue = 0
    } completionHandler: {
      MainActor.assumeIsolated {
        window.orderOut(nil)
        window.contentView = nil
      }
    }
    finished?(setUp)
    finished = nil
  }
}

@MainActor @Observable
final class WelcomeModel {
  enum Step { case welcome, email, code, phone, you, ready }

  /// "Sign in with your phone": this Mac's device sign-in code, waiting for
  /// a signed-in iPhone to scan and approve it.
  enum PhoneSignIn: Equatable {
    case starting
    case showing(DeviceSignIn)
    case denied
    case expired
    case failed(String)
  }

  let needsMove = Install.needsMove
  let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  var moveError: String?
  var step: Step
  var email = ""
  var code = ""
  var name = ""
  var color = PersonColor.cobalt
  /// A new code went out: say so once.
  var resent = false
  var phone = PhoneSignIn.starting
  let account: AccountStore
  @ObservationIgnored let sync: @MainActor () async -> Void
  @ObservationIgnored private let close: (_ setUp: Bool) -> Void
  @ObservationIgnored private var phoneTask: Task<Void, Never>?

  init(
    account: AccountStore, sync: @escaping @MainActor () async -> Void, dismiss: @escaping (_ setUp: Bool) -> Void
  ) {
    self.account = account
    self.sync = sync
    self.close = dismiss
    // Signed in without a name and color yet: straight to You.
    if account.signedIn, let me = account.me, me.profile == nil {
      step = .you
      name = me.suggestedName ?? ""
    } else {
      step = .welcome
    }
    account.error = nil
  }

  /// The frame takes the person's color once they pick one.
  var frameColor: PersonColor { step == .you || step == .ready ? color : .cobalt }

  func go(_ next: Step) {
    account.error = nil
    if next != .phone { stopPhoneSignIn() }
    withAnimation(.easeOutExpo(0.5)) { step = next }
  }

  func dismiss(_ setUp: Bool) {
    stopPhoneSignIn()
    close(setUp)
  }

  // MARK: Sign in with your phone

  func signInWithPhone() {
    go(.phone)
    showNewPhoneCode()
  }

  /// A fresh device code (the first, or after one expired or was denied).
  func showNewPhoneCode() {
    stopPhoneSignIn()
    phone = .starting
    phoneTask = Task { await runPhoneSignIn() }
  }

  private func stopPhoneSignIn() {
    phoneTask?.cancel()
    phoneTask = nil
  }

  /// Shows the code, then polls every `interval` seconds (slower when the
  /// server asks) until the phone approves, denies, or it expires.
  private func runPhoneSignIn() async {
    let started: DeviceSignIn
    do {
      started = try await account.startDeviceSignIn(client: .mac)
    } catch {
      if !Task.isCancelled { phone = .failed(error.localizedDescription) }
      return
    }
    guard !Task.isCancelled else { return }
    phone = .showing(started)
    var interval = started.interval
    while (try? await Task.sleep(for: .seconds(interval))) != nil {
      guard Date.now < started.expiresAt else { phone = .expired; return }
      let poll: DeviceSignInPoll
      do {
        poll = try await account.pollDeviceSignIn(started, interval: interval)
      } catch {
        // A network blip: keep waiting until the code expires.
        continue
      }
      guard !Task.isCancelled else { return }
      switch poll {
      case .pending(let next): interval = next
      case .denied: phone = .denied; return
      case .expired: phone = .expired; return
      case .signedIn:
        // Done polling; leaving this step mustn't cancel the sync that follows.
        phoneTask = nil
        await afterSignIn()
        // Signed in, but loading the account failed: the step offers to try again.
        if step == .phone { phone = .failed(account.error ?? "Couldn’t load your account.") }
        return
      }
    }
  }

  func moveToApplications() {
    do { try Install.moveToApplications() } catch { moveError = error.localizedDescription }
  }

  func sendCode() {
    Task {
      guard await account.sendCode(email: email) else { return }
      code = ""
      resent = false
      go(.code)
    }
  }

  func resend() {
    Task { resent = await account.sendCode(email: account.pendingEmail ?? email) }
  }

  func changeEmail() {
    account.changeEmail()
    code = ""
    go(.email)
  }

  func verify() {
    guard code.count == 6, !account.busy else { return }
    Task {
      if await account.verify(code: code) {
        await afterSignIn()
      } else {
        code = ""
      }
    }
  }

  /// You when there's no profile yet; otherwise sync and done.
  func afterSignIn() async {
    if account.me == nil { await account.refresh() }
    guard let me = account.me else { return }
    if let profile = me.profile {
      name = profile.name
      color = profile.color
      await sync()
      go(.ready)
    } else {
      name = me.suggestedName ?? ""
      go(.you)
    }
  }

  func saveProfile() {
    Task {
      guard await account.saveProfile(name: name, color: color) else { return }
      await sync()
      go(.ready)
    }
  }
}

/// Opened straight from the disk image (or a translocated copy), the app
/// can't update itself or open at login, so the welcome offers to move it.
enum Install {
  private static let destination = URL(filePath: "/Applications/Shouldertap.app")

  static var needsMove: Bool {
    let path = Bundle.main.bundlePath
    return path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/")
  }

  /// Copies this app into Applications (an older copy goes to the Trash),
  /// opens the copy and quits. The copy hasn't seen the welcome, so it shows
  /// it again, without this step.
  @MainActor
  static func moveToApplications() throws {
    let files = FileManager.default
    if files.fileExists(atPath: destination.path) {
      try files.trashItem(at: destination, resultingItemURL: nil)
    }
    try files.copyItem(at: Bundle.main.bundleURL, to: destination)
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: destination, configuration: configuration) { _, _ in
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }
}

// MARK: - Views

struct WelcomeView: View {
  let model: WelcomeModel
  @State private var arrived = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      band
      page
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(model.frameColor.base)
    .animation(.easeOutExpo(0.7), value: model.frameColor)
    .opacity(arrived ? 1 : 0)
    .onAppear {
      withAnimation(.easeOutExpo(0.52)) { arrived = true }
    }
    .ignoresSafeArea()
  }

  /// The wordmark on the frame's top edge, where a tap shows its sender;
  /// the traffic lights sit to its left.
  private var band: some View {
    HStack(spacing: 8) {
      MarkView().frame(width: 20, height: 20)
      Text("Shouldertap")
        .font(.custom(Bricolage.extraBoldName, fixedSize: 18))
        .tracking(-0.035 * 18)
      Spacer(minLength: 0)
      if model.step != .welcome, model.step != .ready {
        Button("Later") { model.dismiss(false) }
          .buttonStyle(.plain)
          .font(Bricolage.bold(14))
          .keyboardShortcut(.cancelAction)
      }
    }
    .foregroundStyle(model.frameColor.ink)
    .padding(.leading, 92)
    .padding(.trailing, 28)
    .frame(height: 52)
  }

  private var page: some View {
    Group {
      switch model.step {
      case .welcome: WelcomeStep(model: model, arrived: arrived)
      case .email: EmailStep(model: model)
      case .code: CodeStep(model: model)
      case .phone: PhoneStep(model: model)
      case .you: YouStep(model: model)
      case .ready: ReadyStep(model: model)
      }
    }
    .transition(.opacity.combined(with: .offset(y: model.reduceMotion ? 0 : 18)))
    .id(model.step)
    .padding(.vertical, 32)
    .padding(.horizontal, 48)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Paper.paper))
    .padding(.horizontal, 16)
    .padding(.bottom, 16)
  }
}

// MARK: Steps

/// One promise, and the frame around it is the live preview: this is how a
/// tap looks.
private struct WelcomeStep: View {
  let model: WelcomeModel
  let arrived: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Welcome to Shouldertap.", size: 64)
        .rise(arrived, delay: 0.08, reduceMotion: model.reduceMotion)
      Lede("When someone you trust taps you on the shoulder, their message covers your screen, just like this, until you answer.")
        .rise(arrived, delay: 0.16, reduceMotion: model.reduceMotion)
      Spacer(minLength: 16)
      VStack(alignment: .leading, spacing: 14) {
        if model.needsMove {
          Text("Shouldertap is running from the disk image. Move it to Applications so it can open at login and stay up to date.")
            .font(Bricolage.medium(15))
            .foregroundStyle(Paper.ink)
        }
        if let error = model.moveError {
          Text("Couldn't move it: \(error) Drag it into Applications from the disk image instead.")
            .font(Bricolage.medium(14))
            .foregroundStyle(Color(nsColor: .systemRed))
        }
        HStack(spacing: 10) {
          if model.needsMove, model.moveError == nil {
            Pill(icon: .mac, label: "Move to Applications", hint: "↩", fill: .cobalt, compact: true) { model.moveToApplications() }
              .keyboardShortcut(.defaultAction)
          } else {
            Pill(label: "Get started", hint: "↩", fill: .cobalt, compact: true) { model.go(.email) }
              .keyboardShortcut(.defaultAction)
          }
          Pill(label: "Later", hint: "esc", compact: true) { model.dismiss(false) }
            .keyboardShortcut(.cancelAction)
        }
        if !model.needsMove || model.moveError != nil {
          HStack(spacing: 24) {
            Quiet("I have an account") { model.go(.email) }
            Quiet("Sign in with your phone") { model.signInWithPhone() }
          }
        }
      }
      .rise(arrived, delay: 0.3, reduceMotion: model.reduceMotion)
    }
  }
}

private struct EmailStep: View {
  @Bindable var model: WelcomeModel
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "What's your email?", size: 52)
      Lede("We'll send you a code to sign in. No password to remember.")
      PaperField(placeholder: "you@example.com", text: $model.email)
        .focused($focused)
        .onSubmit(model.sendCode)
        .frame(maxWidth: 440)
        .padding(.top, 28)
      ErrorLine(model.account.error)
      Spacer(minLength: 16)
      HStack(spacing: 10) {
        Pill(label: model.account.busy ? "Sending…" : "Send code", hint: "↩", fill: .cobalt, compact: true, action: model.sendCode)
          .keyboardShortcut(.defaultAction)
          .disabled(model.account.busy || model.email.trimmingCharacters(in: .whitespaces).isEmpty)
        Pill(icon: .back, label: "Back", compact: true) { model.go(.welcome) }
      }
      Quiet("Sign in with your phone instead") { model.signInWithPhone() }
        .padding(.top, 18)
    }
    .onAppear { focused = true }
  }
}

/// "Sign in with your phone": a QR code of this Mac's device sign-in link
/// and the code under it, for a signed-in iPhone to scan and approve.
private struct PhoneStep: View {
  let model: WelcomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Sign in with your phone.", size: 52)
      Lede("Open Shouldertap on your iPhone → Account → Sign in on a computer, and scan this.")
      HStack(alignment: .center, spacing: 32) {
        code
      }
      .padding(.top, 20)
      Spacer(minLength: 16)
      HStack(spacing: 10) {
        switch model.phone {
        case .denied, .expired:
          Pill(label: "Show a new code", hint: "↩", fill: .cobalt, compact: true) { model.showNewPhoneCode() }
            .keyboardShortcut(.defaultAction)
        case .failed:
          if model.account.signedIn {
            Pill(label: "Try again", hint: "↩", fill: .cobalt, compact: true) { Task { await model.afterSignIn() } }
              .keyboardShortcut(.defaultAction)
          } else {
            Pill(label: "Show a new code", hint: "↩", fill: .cobalt, compact: true) { model.showNewPhoneCode() }
              .keyboardShortcut(.defaultAction)
          }
        case .starting, .showing:
          EmptyView()
        }
        Pill(icon: .back, label: "Back", compact: true) { model.go(.welcome) }
      }
      Quiet("Use your email instead") { model.go(.email) }
        .padding(.top, 14)
    }
  }

  @ViewBuilder private var code: some View {
    let side: CGFloat = 168
    switch model.phone {
    case .starting:
      ProgressView().frame(width: side, height: side)
    case .showing(let started):
      if let image = QRCode.image(for: started.url) {
        Image(nsImage: image)
          .interpolation(.none)
          .resizable()
          .frame(width: side, height: side)
          .padding(12)
          .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.white))
          .accessibilityLabel("QR code to sign in this Mac")
      }
      VStack(alignment: .leading, spacing: 10) {
        Text(started.userCode)
          .font(Bricolage.extraBold(44))
          .monospaced()
          .tracking(4)
          .foregroundStyle(Paper.ink)
          .textSelection(.enabled)
          .accessibilityLabel("Code \(started.userCode.map(String.init).joined(separator: " "))")
        Text("Your iPhone shows this code too. Check they match.")
          .font(Bricolage.medium(15))
          .foregroundStyle(Paper.tone)
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Waiting for your iPhone…").font(Bricolage.medium(14)).foregroundStyle(Paper.tone)
        }
        .padding(.top, 6)
      }
    case .denied:
      Notice("Your iPhone didn’t approve this Mac.")
    case .expired:
      Notice("That code expired.")
    case .failed(let message):
      Notice(message)
    }
  }
}

private struct Notice: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text).font(Bricolage.bold(20)).foregroundStyle(Paper.ink)
  }
}

private struct CodeStep: View {
  @Bindable var model: WelcomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Check your email.", size: 52)
      Lede("Enter the six digits we sent to \(model.account.pendingEmail ?? model.email).")
      CodeBoxes(code: $model.code, color: .cobalt, onComplete: model.verify)
        .disabled(model.account.busy)
        .padding(.top, 28)
      ErrorLine(model.account.error)
      if model.resent, model.account.error == nil {
        Text("Sent a new code.").font(Bricolage.medium(14)).foregroundStyle(Paper.tone).padding(.top, 14)
      }
      Spacer(minLength: 16)
      HStack(spacing: 10) {
        if model.account.signedIn {
          // Signed in, but loading the account failed: try that again.
          Pill(label: "Try again", hint: "↩", fill: .cobalt, compact: true) { Task { await model.afterSignIn() } }
            .keyboardShortcut(.defaultAction)
        } else {
          Pill(label: "Resend", compact: true) { model.resend() }.disabled(model.account.busy)
          Pill(icon: .back, label: "Change email", compact: true) { model.changeEmail() }
          if model.account.busy { ProgressView().controlSize(.small) }
        }
      }
    }
  }
}

private struct YouStep: View {
  @Bindable var model: WelcomeModel
  @FocusState private var focused: Bool

  private var preview: String {
    let name = model.name.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? "You" : name
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "What should people call you?", size: 46)
      Lede("Your name and color frame every tap you send, so they know it's you from across the room.")
      HStack(alignment: .top, spacing: 32) {
        VStack(alignment: .leading, spacing: 20) {
          PaperField(placeholder: "Your first name", text: $model.name)
            .focused($focused)
            .onSubmit(model.saveProfile)
            .onChange(of: model.name) { _, value in
              if value.count > maxNameLength { model.name = String(value.prefix(maxNameLength)) }
            }
          ColorGrid(selection: $model.color)
        }
        .frame(maxWidth: 340)
        SenderPreview(name: preview, color: model.color, large: true)
          .frame(maxWidth: 320)
      }
      .padding(.top, 24)
      ErrorLine(model.account.error)
      Spacer(minLength: 16)
      Pill(label: model.account.busy ? "Saving…" : "Continue", hint: "↩", fill: model.color, compact: true, action: model.saveProfile)
        .keyboardShortcut(.defaultAction)
        .disabled(model.account.busy || model.name.trimmingCharacters(in: .whitespaces).isEmpty)
    }
    .onAppear { focused = true }
  }
}

private struct ReadyStep: View {
  let model: WelcomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "You're all set, \(model.name).", size: 56)
      Lede("Shouldertap lives in your menu bar: look for the mark knocking up there. Invite someone from it; when they tap, it covers this screen until you answer.")
      Spacer(minLength: 16)
      Pill(label: "Open the menu", hint: "↩", fill: model.color, compact: true) { model.dismiss(true) }
        .keyboardShortcut(.defaultAction)
    }
  }
}

// MARK: Pieces

private struct Lede: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text)
      .font(Bricolage.medium(18))
      .foregroundStyle(Paper.tone)
      .lineSpacing(3)
      .frame(maxWidth: 600, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.top, 18)
  }
}

/// A quiet text link under the pills.
private struct Quiet: View {
  let label: String
  let action: () -> Void
  init(_ label: String, action: @escaping () -> Void) {
    self.label = label
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      Text(label).font(Bricolage.medium(15)).underline().foregroundStyle(Paper.tone)
    }
    .buttonStyle(.plain)
    .focusable(false)
  }
}

private struct ErrorLine: View {
  let text: String?
  init(_ text: String?) { self.text = text }

  var body: some View {
    if let text {
      Text(text).font(Bricolage.medium(14)).foregroundStyle(Color(nsColor: .systemRed)).padding(.top, 12)
    }
  }
}

/// Fields: `faint` fill, radius 18, no border (docs/design.md).
private struct PaperField: View {
  let placeholder: String
  @Binding var text: String

  var body: some View {
    TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Paper.tone))
      .textFieldStyle(.plain)
      .font(Bricolage.medium(20))
      .foregroundStyle(Paper.ink)
      .padding(.horizontal, 18)
      .frame(height: 54)
      .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Paper.faint))
  }
}

/// Six boxes over one field: typing, pasting or the system's code autofill
/// all land in it, and six digits submit on their own.
struct CodeBoxes: View {
  @Binding var code: String
  let color: PersonColor
  let onComplete: () -> Void
  @FocusState private var focused: Bool

  var body: some View {
    ZStack(alignment: .leading) {
      TextField("", text: $code)
        .textFieldStyle(.plain)
        .textContentType(.oneTimeCode)
        .focused($focused)
        .opacity(0.001)
        .frame(width: 6 * 60 + 5 * 10, height: 70)
        .onChange(of: code) { _, value in
          let digits = String(value.filter(\.isNumber).prefix(6))
          if digits != value { code = digits }
          if digits.count == 6 { onComplete() }
        }
      HStack(spacing: 10) {
        ForEach(0..<6, id: \.self) { index in
          Text(index < code.count ? String(Array(code)[index]) : "")
            .font(Bricolage.bold(36))
            .monospacedDigit()
            .foregroundStyle(Paper.ink)
            .frame(width: 60, height: 70)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Paper.faint))
            .overlay(
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(color.base, lineWidth: focused && index == min(code.count, 5) ? 3 : 0))
        }
      }
      .allowsHitTesting(false)
    }
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
    .onAppear { focused = true }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Six-digit code, \(code.count) of 6 entered")
  }
}

/// The eight person colors; the selected one carries a tick in its ink.
struct ColorGrid: View {
  @Binding var selection: PersonColor

  var body: some View {
    LazyVGrid(
      columns: Array(repeating: GridItem(.fixed(44), spacing: 12), count: 4), alignment: .leading, spacing: 12
    ) {
      ForEach(PersonColor.allCases, id: \.self) { option in
        Button {
          selection = option
        } label: {
          Circle()
            .fill(option.base)
            .overlay { if option == selection { IconView(icon: .onIt, size: 20).foregroundStyle(option.ink) } }
            .overlay(
              Circle().strokeBorder(Paper.ink.opacity(option == selection ? 0.85 : 0), lineWidth: 2.5).padding(-5))
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .accessibilityLabel(option.swatch.label)
        .accessibilityAddTraits(option == selection ? .isSelected : [])
      }
    }
  }
}

extension View {
  /// Staggered arrival: fade in with an 18pt rise (opacity only with Reduce Motion).
  fileprivate func rise(_ arrived: Bool, delay: Double, reduceMotion: Bool) -> some View {
    opacity(arrived ? 1 : 0)
      .offset(y: arrived || reduceMotion ? 0 : 18)
      .animation(.easeOutExpo(0.7).delay(delay), value: arrived)
  }
}
