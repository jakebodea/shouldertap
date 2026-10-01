import AppKit
import CoreImage.CIFilterBuiltins
import Network
import ShouldertapCore
import SwiftUI

@main
enum Main {
  static func main() {
    MainActor.assumeIsolated {
      let app = NSApplication.shared
      let delegate = AppDelegate()
      app.delegate = delegate
      app.setActivationPolicy(.accessory)
      withExtendedLifetime(delegate) { app.run() }
    }
  }
}

/// Where this Mac connects: debug builds use the local `alchemy dev` stack,
/// release builds production (domains.ts at the repo root). Debug builds can
/// point elsewhere with SHOULDERTAP_SERVER_URL and SHOULDERTAP_WEB_URL.
enum Config {
  static var endpoints: Endpoints {
    #if DEBUG
      let env = ProcessInfo.processInfo.environment
      return Endpoints(
        server: URL(string: env["SHOULDERTAP_SERVER_URL"] ?? "http://localhost:3000")!,
        web: URL(string: env["SHOULDERTAP_WEB_URL"] ?? "http://localhost:3001")!)
    #else
      return Endpoints(server: URL(string: "https://api.shouldertap.app")!, web: URL(string: "https://shouldertap.app")!)
    #endif
  }

  /// Developer ID builds keep the credential in the Keychain, under their
  /// own bundle id; ad-hoc builds would be prompted after every update, so
  /// they keep the file.
  static var vault: (any CredentialVault)? {
    guard CodeSignature.teamIdentifier != nil else { return nil }
    return KeychainVault(service: Bundle.main.bundleIdentifier ?? "app.shouldertap.mac")
  }

  /// Debug builds keep their own pairing (and, via their own bundle id, their
  /// own defaults) so testing never touches the installed app's.
  static var persistence: LocalPersistence {
    #if DEBUG
      LocalPersistence(
        directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
          .appending(path: "Shouldertap Debug", directoryHint: .isDirectory),
        vault: vault)
    #else
      LocalPersistence(vault: vault)
    #endif
  }
}

/// Menu-bar-only app: a status item with a SwiftUI popover, plus full-screen
/// overlays when a tap arrives.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let store = ReceiverStore(
    endpoints: Config.endpoints,
    persistence: Config.persistence,
    deviceName: { Host.current().localizedName ?? "Mac" })
  private lazy var overlays = OverlayController(store: store)
  private let updates = Updates()
  private let popover = NSPopover()
  private var statusItem: NSStatusItem!
  private let knock = KnockAnimator()
  private let network = NWPathMonitor()
  private var networkWasUp = true

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = statusItem.button {
      button.image = ShouldertapMark.templateImage(knocks: KnockAnimator.resting)
      button.target = self
      button.action = #selector(togglePopover)
      knock.button = button
    }

    popover.behavior = .transient
    popover.animates = true
    popover.delegate = self

    observeStore()
    observeWake()
    observeNetwork()

    if !store.start() {
      // Not set up yet: open the menu so there's somewhere to start.
      DispatchQueue.main.async { self.openPopover() }
    }
  }

  /// Launching the app again (Finder, Spotlight, `open`) shows the menu.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openPopover()
    return false
  }

  // MARK: Popover

  @objc private func togglePopover() {
    popover.isShown ? popover.performClose(nil) : openPopover()
  }

  private func openPopover() {
    guard let button = statusItem.button else { return }
    if popover.contentViewController == nil {
      let controller = NSHostingController(rootView: MenuView(store: store, updates: updates))
      controller.sizingOptions = .preferredContentSize
      popover.contentViewController = controller
    }
    NSApp.activate(ignoringOtherApps: true)
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }

  // MARK: Store → overlay and menu bar

  /// Re-run whenever the active tap changes (Observation: no polling).
  private func observeStore() {
    let active = withObservationTracking {
      store.activeTap
    } onChange: { [weak self] in
      Task { @MainActor in self?.observeStore() }
    }
    overlays.update(active)
    knock.pending = active != nil
  }

  private func observeWake() {
    let center = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.store.nudge() }
      }
    }
  }

  /// Reconnect as soon as the network comes back instead of waiting out the backoff.
  private func observeNetwork() {
    network.pathUpdateHandler = { [weak self] path in
      let up = path.status == .satisfied
      Task { @MainActor in
        guard let self else { return }
        if up, !self.networkWasUp { self.store.nudge() }
        self.networkWasUp = up
      }
    }
    network.start(queue: .global(qos: .utility))
  }
}

extension AppDelegate: NSPopoverDelegate {
  /// The menu is open for seconds a day: free its views when it closes so the
  /// app idles at its smallest.
  func popoverDidClose(_ notification: Notification) {
    popover.contentViewController = nil
  }
}

/// The menu bar always shows the full mark. While a tap waits, the knock marks
/// knock twice (DESIGN.md, "Motion") and again every few seconds until it is
/// answered, never with Reduce Motion. Frames run only during a knock; between
/// knocks a single timer sleeps.
@MainActor
final class KnockAnimator {
  static let resting = [ShouldertapMark.Knock](repeating: .shown, count: 3)
  private static let every: TimeInterval = 4

  weak var button: NSStatusBarButton?
  private var frameTimer: Timer?
  private var nextKnock: Timer?

  var pending = false {
    didSet {
      guard pending != oldValue else { return }
      stop()
      if pending, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { start() }
    }
  }

  private func start() {
    let start = Date()
    let frames = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.frame(since: start) }
    }
    RunLoop.main.add(frames, forMode: .common)
    frameTimer = frames

    let next = Timer(timeInterval: Self.every, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { if self?.pending == true { self?.start() } }
    }
    next.tolerance = 0.5
    RunLoop.main.add(next, forMode: .common)
    nextKnock = next
  }

  private func frame(since start: Date) {
    let elapsed = Date().timeIntervalSince(start)
    guard elapsed < ShouldertapMark.knockDuration else {
      frameTimer?.invalidate()
      frameTimer = nil
      button?.image = ShouldertapMark.templateImage(knocks: Self.resting)
      return
    }
    button?.image = ShouldertapMark.templateImage(knocks: ShouldertapMark.knockStates(elapsed: elapsed))
  }

  private func stop() {
    frameTimer?.invalidate()
    nextKnock?.invalidate()
    frameTimer = nil
    nextKnock = nil
    button?.image = ShouldertapMark.templateImage(knocks: Self.resting)
  }
}

enum QRCode {
  /// A crisp QR image for the invite link; scale it with `.interpolation(.none)`.
  static func image(for text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else {
      return nil
    }
    let rep = NSCIImageRep(ciImage: output)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    return image
  }
}

/// The mark in SwiftUI as a vector shape, in the current foreground color.
/// (A `Canvas` drawing through Core Graphics cost ~60 MB at first draw.)
struct MarkView: View {
  var body: some View {
    MarkShape().fill(.primary).accessibilityHidden(true)
  }
}

private struct MarkShape: Shape {
  func path(in rect: CGRect) -> Path {
    let bounds = ShouldertapMark.bounds
    let scale = min(rect.width / bounds.width, rect.height / bounds.height)
    var mark = Path(ShouldertapMark.framePath().cgPath)
      .strokedPath(StrokeStyle(lineWidth: ShouldertapMark.frameWidth, lineCap: .round, lineJoin: .round))
    for knock in ShouldertapMark.knocks {
      var line = Path()
      line.move(to: knock.from)
      line.addLine(to: knock.to)
      mark.addPath(line.strokedPath(StrokeStyle(lineWidth: ShouldertapMark.knockWidth, lineCap: .round)))
    }
    return mark.applying(
      CGAffineTransform(translationX: rect.midX, y: rect.midY)
        .scaledBy(x: scale, y: scale)
        .translatedBy(x: -bounds.midX, y: -bounds.midY))
  }
}
