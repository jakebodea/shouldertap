import AppKit
import ShouldertapCore
import SwiftUI

/// The first run (docs/onboarding.md, "The flow"): a full-screen Frame in
/// Cobalt, under the menu bar so the real icon stays visible (and knocks).
/// Welcome → email → code → you (name and color, once) → ready. Shown on
/// first launch, and again from the menu until this Mac is signed in.
@MainActor
final class WelcomeController {
  private static let seenKey = "welcomeSeen"

  /// Not seen yet. Debug builds show it every launch with SHOULDERTAP_WELCOME=1.
  static var shouldShow: Bool {
    #if DEBUG
      if ProcessInfo.processInfo.environment["SHOULDERTAP_WELCOME"] != nil { return true }
    #endif
    return !UserDefaults.standard.bool(forKey: seenKey)
  }

  private var window: OverlayWindow?
  private var finished: ((_ setUp: Bool) -> Void)?
  private var itemMoves: (any NSObjectProtocol)?

  var isShowing: Bool { window != nil }

  /// `item` is the status item's window. `finished` runs once the welcome
  /// is dismissed, `setUp` true when the menu should open next.
  func show(
    on screen: NSScreen, item: NSWindow, account: AccountStore, sync: @escaping @MainActor () async -> Void,
    finished: @escaping (_ setUp: Bool) -> Void
  ) {
    guard window == nil else { return }
    self.finished = finished
    let window = OverlayWindow(screen: screen)
    // Just under the menu bar, which stays live above it.
    window.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1)
    let menuBar = screen.frame.maxY - screen.visibleFrame.maxY
    let model = WelcomeModel(
      pointerX: Self.pointerX(item.frame, on: screen),
      menuBarHeight: menuBar > 0 ? menuBar : NSStatusBar.system.thickness,
      account: account, sync: sync,
      dismiss: { [weak self] setUp in self?.dismiss(setUp: setUp) })
    let host = NSHostingView(rootView: WelcomeView(model: model))
    host.frame = NSRect(origin: .zero, size: screen.frame.size)
    window.contentView = host
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    self.window = window
    // Right after launch the menu bar hasn't placed the item yet.
    itemMoves = NotificationCenter.default.addObserver(
      forName: NSWindow.didMoveNotification, object: item, queue: .main
    ) { [weak self, weak model] _ in
      MainActor.assumeIsolated {
        guard let screen = self?.window?.screen else { return }
        let x = Self.pointerX(item.frame, on: screen)
        withAnimation(.easeOutExpo(0.5)) { model?.pointerX = x }
      }
    }
  }

  /// Leaves with the overlay's 420ms fade.
  func dismiss(setUp: Bool) {
    guard let window else { return }
    self.window = nil
    if let itemMoves { NotificationCenter.default.removeObserver(itemMoves) }
    itemMoves = nil
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

  /// The item's center in the window's coordinates, or nil when there's
  /// nothing to point at: not placed yet, or hidden behind the notch of a
  /// crowded menu bar.
  private static func pointerX(_ item: NSRect, on screen: NSScreen) -> CGFloat? {
    guard item.width > 0, screen.frame.contains(NSPoint(x: item.midX, y: item.midY)) else { return nil }
    if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea,
      item.midX > left.maxX, item.midX < right.minX
    {
      return nil
    }
    return item.midX - screen.frame.minX
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

  /// Where the menu bar icon is, in the window's coordinates; nil if hidden.
  var pointerX: CGFloat?
  let menuBarHeight: CGFloat
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
    pointerX: CGFloat?, menuBarHeight: CGFloat, account: AccountStore, sync: @escaping @MainActor () async -> Void,
    dismiss: @escaping (_ setUp: Bool) -> Void
  ) {
    self.pointerX = pointerX
    self.menuBarHeight = menuBarHeight
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
    GeometryReader { geometry in
      let scale = min(1.4, max(0.7, min(geometry.size.width / 1440, geometry.size.height / 900)))
      VStack(alignment: .leading, spacing: 0) {
        Color.clear.frame(height: model.menuBarHeight)
        band
        page(scale: scale)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(model.frameColor.base)
      .animation(.easeOutExpo(0.7), value: model.frameColor)
      .overlay(alignment: .topLeading) {
        if let x = model.pointerX, model.step == .welcome || model.step == .ready {
          // Trailing edge half an arrow past the icon's center, so the arrow sits under it.
          MenuBarPointer(color: model.frameColor, reduceMotion: model.reduceMotion)
            .frame(width: x + MenuBarPointer.arrowWidth / 2, alignment: .trailing)
            .padding(.top, model.menuBarHeight + 6)
            .rise(arrived, delay: 0.5, reduceMotion: model.reduceMotion)
        }
      }
    }
    .opacity(arrived ? 1 : 0)
    .onAppear {
      withAnimation(.easeOutExpo(0.52)) { arrived = true }
    }
    .ignoresSafeArea()
  }

  /// The wordmark on the frame's top edge, where a tap shows its sender.
  private var band: some View {
    HStack(spacing: 12) {
      MarkView().frame(width: 34, height: 34)
      Text("Shouldertap")
        .font(.custom(Bricolage.extraBoldName, fixedSize: 32))
        .tracking(-0.035 * 32)
      Spacer(minLength: 0)
      if model.step != .welcome, model.step != .ready {
        Button("Later") { model.dismiss(false) }
          .buttonStyle(.plain)
          .font(Bricolage.bold(17))
          .keyboardShortcut(.cancelAction)
      }
    }
    .foregroundStyle(model.frameColor.ink)
    .padding(.top, 26)
    .padding(.horizontal, 72)
    .frame(height: 96, alignment: .topLeading)
  }

  private func page(scale: CGFloat) -> some View {
    Group {
      switch model.step {
      case .welcome: WelcomeStep(model: model, scale: scale, arrived: arrived)
      case .email: EmailStep(model: model, scale: scale)
      case .code: CodeStep(model: model, scale: scale)
      case .phone: PhoneStep(model: model, scale: scale)
      case .you: YouStep(model: model, scale: scale)
      case .ready: ReadyStep(model: model, scale: scale)
      }
    }
    .transition(.opacity.combined(with: .offset(y: model.reduceMotion ? 0 : 18)))
    .id(model.step)
    .padding(.vertical, 64)
    .padding(.horizontal, 72)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Paper.paper))
    .padding(.horizontal, 40)
    .padding(.bottom, 40)
  }
}

// MARK: Steps

/// One promise, and the frame around it is the live preview: this is how a
/// tap looks.
private struct WelcomeStep: View {
  let model: WelcomeModel
  let scale: CGFloat
  let arrived: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Welcome to Shouldertap.", size: (128 * scale).rounded())
        .rise(arrived, delay: 0.08, reduceMotion: model.reduceMotion)
      Lede("When someone you trust taps you on the shoulder, their message covers your screen, just like this, until you answer.")
        .rise(arrived, delay: 0.16, reduceMotion: model.reduceMotion)
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 18) {
        if model.needsMove {
          Text("Shouldertap is running from the disk image. Move it to Applications so it can open at login and stay up to date.")
            .font(Bricolage.medium(19))
            .foregroundStyle(Paper.ink)
        }
        if let error = model.moveError {
          Text("Couldn't move it: \(error) Drag it into Applications from the disk image instead.")
            .font(Bricolage.medium(17))
            .foregroundStyle(Color(nsColor: .systemRed))
        }
        HStack(spacing: 14) {
          if model.needsMove, model.moveError == nil {
            Pill(icon: .mac, label: "Move to Applications", hint: "↩", fill: .cobalt) { model.moveToApplications() }
              .keyboardShortcut(.defaultAction)
          } else {
            Pill(label: "Get started", hint: "↩", fill: .cobalt) { model.go(.email) }
              .keyboardShortcut(.defaultAction)
          }
          Pill(label: "Later", hint: "esc") { model.dismiss(false) }
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
  let scale: CGFloat
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "What's your email?", size: (104 * scale).rounded())
      Lede("We'll send you a code to sign in. No password to remember.")
      PaperField(placeholder: "you@example.com", text: $model.email)
        .focused($focused)
        .onSubmit(model.sendCode)
        .frame(maxWidth: 560)
        .padding(.top, 40)
      ErrorLine(model.account.error)
      Spacer(minLength: 40)
      HStack(spacing: 14) {
        Pill(label: model.account.busy ? "Sending…" : "Send code", hint: "↩", fill: .cobalt, action: model.sendCode)
          .keyboardShortcut(.defaultAction)
          .disabled(model.account.busy || model.email.trimmingCharacters(in: .whitespaces).isEmpty)
        Pill(icon: .back, label: "Back") { model.go(.welcome) }
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
  let scale: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Sign in with your phone.", size: (104 * scale).rounded())
      Lede("Open Shouldertap on your iPhone → Account → Sign in on a computer, and scan this.")
      HStack(alignment: .center, spacing: 48) {
        code
      }
      .padding(.top, 40)
      Spacer(minLength: 40)
      HStack(spacing: 14) {
        switch model.phone {
        case .denied, .expired:
          Pill(label: "Show a new code", hint: "↩", fill: .cobalt) { model.showNewPhoneCode() }
            .keyboardShortcut(.defaultAction)
        case .failed:
          if model.account.signedIn {
            Pill(label: "Try again", hint: "↩", fill: .cobalt) { Task { await model.afterSignIn() } }
              .keyboardShortcut(.defaultAction)
          } else {
            Pill(label: "Show a new code", hint: "↩", fill: .cobalt) { model.showNewPhoneCode() }
              .keyboardShortcut(.defaultAction)
          }
        case .starting, .showing:
          EmptyView()
        }
        Pill(icon: .back, label: "Back") { model.go(.welcome) }
      }
      Quiet("Use your email instead") { model.go(.email) }
        .padding(.top, 18)
    }
  }

  @ViewBuilder private var code: some View {
    let side = (280 * scale).rounded()
    switch model.phone {
    case .starting:
      ProgressView().frame(width: side, height: side)
    case .showing(let started):
      if let image = QRCode.image(for: started.url) {
        Image(nsImage: image)
          .interpolation(.none)
          .resizable()
          .frame(width: side, height: side)
          .padding(16)
          .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.white))
          .accessibilityLabel("QR code to sign in this Mac")
      }
      VStack(alignment: .leading, spacing: 10) {
        Text(started.userCode)
          .font(Bricolage.extraBold((72 * scale).rounded()))
          .monospaced()
          .tracking(4)
          .foregroundStyle(Paper.ink)
          .textSelection(.enabled)
          .accessibilityLabel("Code \(started.userCode.map(String.init).joined(separator: " "))")
        Text("Your iPhone shows this code too. Check they match.")
          .font(Bricolage.medium(19))
          .foregroundStyle(Paper.tone)
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Waiting for your iPhone…").font(Bricolage.medium(17)).foregroundStyle(Paper.tone)
        }
        .padding(.top, 10)
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
    Text(text).font(Bricolage.bold(26)).foregroundStyle(Paper.ink)
  }
}

private struct CodeStep: View {
  @Bindable var model: WelcomeModel
  let scale: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Check your email.", size: (104 * scale).rounded())
      Lede("Enter the six digits we sent to \(model.account.pendingEmail ?? model.email).")
      CodeBoxes(code: $model.code, color: .cobalt, onComplete: model.verify)
        .disabled(model.account.busy)
        .padding(.top, 40)
      ErrorLine(model.account.error)
      if model.resent, model.account.error == nil {
        Text("Sent a new code.").font(Bricolage.medium(17)).foregroundStyle(Paper.tone).padding(.top, 14)
      }
      Spacer(minLength: 40)
      HStack(spacing: 14) {
        if model.account.signedIn {
          // Signed in, but loading the account failed: try that again.
          Pill(label: "Try again", hint: "↩", fill: .cobalt) { Task { await model.afterSignIn() } }
            .keyboardShortcut(.defaultAction)
        } else {
          Pill(label: "Resend") { model.resend() }.disabled(model.account.busy)
          Pill(icon: .back, label: "Change email") { model.changeEmail() }
          if model.account.busy { ProgressView().controlSize(.small) }
        }
      }
    }
  }
}

private struct YouStep: View {
  @Bindable var model: WelcomeModel
  let scale: CGFloat
  @FocusState private var focused: Bool

  private var preview: String {
    let name = model.name.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? "You" : name
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "What should people call you?", size: (88 * scale).rounded())
      Lede("Your name and color frame every tap you send, so they know it's you from across the room.")
      HStack(alignment: .top, spacing: 48) {
        VStack(alignment: .leading, spacing: 28) {
          PaperField(placeholder: "Your first name", text: $model.name)
            .focused($focused)
            .onSubmit(model.saveProfile)
            .onChange(of: model.name) { _, value in
              if value.count > maxNameLength { model.name = String(value.prefix(maxNameLength)) }
            }
          ColorGrid(selection: $model.color)
        }
        .frame(maxWidth: 480)
        SenderPreview(name: preview, color: model.color, large: true)
          .frame(maxWidth: 440)
      }
      .padding(.top, 40)
      ErrorLine(model.account.error)
      Spacer(minLength: 40)
      Pill(label: model.account.busy ? "Saving…" : "Continue", hint: "↩", fill: model.color, action: model.saveProfile)
        .keyboardShortcut(.defaultAction)
        .disabled(model.account.busy || model.name.trimmingCharacters(in: .whitespaces).isEmpty)
    }
    .onAppear { focused = true }
  }
}

private struct ReadyStep: View {
  let model: WelcomeModel
  let scale: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "You're all set, \(model.name).", size: (112 * scale).rounded())
      Lede("Shouldertap lives in your menu bar. Invite someone from there; when they tap, it covers this screen until you answer.")
      Spacer(minLength: 40)
      Pill(label: "Open the menu", hint: "↩", fill: model.color) { model.dismiss(true) }
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
      .font(Bricolage.medium(26))
      .foregroundStyle(Paper.tone)
      .lineSpacing(4)
      .frame(maxWidth: 820, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.top, 28)
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
      Text(label).font(Bricolage.medium(19)).underline().foregroundStyle(Paper.tone)
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
      Text(text).font(Bricolage.medium(17)).foregroundStyle(Color(nsColor: .systemRed)).padding(.top, 14)
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
      .font(Bricolage.medium(26))
      .foregroundStyle(Paper.ink)
      .padding(.horizontal, 22)
      .frame(height: 68)
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
        .frame(width: 6 * 72 + 5 * 12, height: 84)
        .onChange(of: code) { _, value in
          let digits = String(value.filter(\.isNumber).prefix(6))
          if digits != value { code = digits }
          if digits.count == 6 { onComplete() }
        }
      HStack(spacing: 12) {
        ForEach(0..<6, id: \.self) { index in
          Text(index < code.count ? String(Array(code)[index]) : "")
            .font(Bricolage.bold(44))
            .monospacedDigit()
            .foregroundStyle(Paper.ink)
            .frame(width: 72, height: 84)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Paper.faint))
            .overlay(
              RoundedRectangle(cornerRadius: 18, style: .continuous)
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
      columns: Array(repeating: GridItem(.fixed(52), spacing: 14), count: 4), alignment: .leading, spacing: 14
    ) {
      ForEach(PersonColor.allCases, id: \.self) { option in
        Button {
          selection = option
        } label: {
          Circle()
            .fill(option.base)
            .overlay { if option == selection { IconView(icon: .onIt, size: 22).foregroundStyle(option.ink) } }
            .overlay(
              Circle().strokeBorder(Paper.ink.opacity(option == selection ? 0.85 : 0), lineWidth: 2.5).padding(-5))
            .frame(width: 52, height: 52)
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

/// An arrow up at the menu bar icon, with its label to the left; it bobs
/// gently unless Reduce Motion is on.
private struct MenuBarPointer: View {
  nonisolated static let arrowWidth: CGFloat = 28
  let color: PersonColor
  let reduceMotion: Bool
  @State private var up = false

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text("Shouldertap lives up here")
        .font(Bricolage.bold(20))
        .tracking(-0.2)
        .padding(.top, 34)
      UpArrow()
        .stroke(style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
        .frame(width: Self.arrowWidth, height: 52)
    }
    .foregroundStyle(color.ink)
    .offset(y: up ? -5 : 2)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { up = true }
    }
    .accessibilityElement(children: .combine)
  }
}

private struct UpArrow: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.midX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.midX, y: rect.minY + 2))
    path.move(to: CGPoint(x: rect.minX + 2, y: rect.minY + rect.width / 2))
    path.addLine(to: CGPoint(x: rect.midX, y: rect.minY + 2))
    path.addLine(to: CGPoint(x: rect.maxX - 2, y: rect.minY + rect.width / 2))
    return path
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
