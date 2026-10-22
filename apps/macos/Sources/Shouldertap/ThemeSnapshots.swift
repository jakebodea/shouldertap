#if DEBUG
  import AppKit
  import ShouldertapCore
  import SwiftUI

  /// Debug builds only: `SHOULDERTAP_RENDER_THEMES=<dir>` opens each theme in a
  /// real window, captures it mid-arrival and settled with `screencapture -l`,
  /// then quits. Used to check the native renderers against the approved
  /// mockup; needs no server.
  @MainActor
  enum ThemeSnapshots {
    struct Case {
      var name: String
      var theme: TapTheme
      var color: PersonColor
      var body: String
      var size = CGSize(width: 1440, height: 900)
      var replying = false
      var reduce = false
      var frames: [Double] = [4.2]
    }

    static let short = "Door! Package guy is here."
    static let long =
      "When you get a sec: the plumber needs the boxes moved out from under the kitchen sink before 3, and I'm stuck on this call until 2:45. Can you handle it? Thank you!!"
    static let stress =
      "Pls sign before noon or the slot goes away: https://forms.example.com/school/permission-slip/fieldtrip-2026-10-24?student=ada-lovelace-hopper thx"

    static var cases: [Case] {
      var all: [Case] = []
      let colors: [TapTheme: [PersonColor]] = [
        .default: [.moss], .broadsheet: [.moss, .sky], .billboard: [.tomato, .ochre], .terminal: [.moss, .plum],
        .note: [.cobalt, .rose],
      ]
      for theme in TapTheme.allCases {
        for color in colors[theme] ?? [] {
          all.append(Case(name: "short-\(theme)-\(color)", theme: theme, color: color, body: short))
        }
        let color = colors[theme]![0]
        all.append(Case(name: "long-\(theme)", theme: theme, color: color, body: long))
        all.append(Case(name: "stress-\(theme)", theme: theme, color: color, body: stress))
        all.append(Case(name: "reply-\(theme)", theme: theme, color: color, body: short, replying: true))
        if theme != .default {
          all.append(
            Case(name: "motion-\(theme)", theme: theme, color: color, body: short, frames: [0.15, 0.4, 0.7, 4.2]))
          all.append(Case(name: "reduced-\(theme)", theme: theme, color: color, body: short, reduce: true, frames: [0.25]))
          all.append(
            Case(name: "portrait-\(theme)", theme: theme, color: color, body: long, size: CGSize(width: 820, height: 1180)))
        }
      }
      for color in PersonColor.allCases {
        for theme in TapTheme.allCases where theme != .default {
          all.append(Case(name: "colors-\(theme)-\(color)", theme: theme, color: color, body: short))
        }
      }
      return all
    }

    static func run(into directory: String) {
      try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      let only = ProcessInfo.processInfo.environment["SHOULDERTAP_RENDER_ONLY"]
      let queue = cases.filter { only == nil || $0.name.contains(only!) }
      Task { @MainActor in
        for item in queue { await capture(item, into: directory) }
        await appearanceWindow(into: directory)
        if only == nil || "welcome".contains(only!) { await welcomeSteps(into: directory) }
        NSApp.terminate(nil)
      }
    }

    private static func capture(_ item: Case, into directory: String) async {
      let tap = Tap(
        id: UUID().uuidString, senderId: "s1", senderName: "Maya", senderColor: item.color, body: item.body,
        createdAt: Date.now.timeIntervalSince1970 * 1000 - 120_000)
      let model = OverlayModel(
        active: ActiveTap(tap: tap, queued: 1), theme: item.theme, reduceMotion: item.reduce, respond: { _, _ in })
      model.replying = item.replying
      let window = NSWindow(
        contentRect: NSRect(origin: CGPoint(x: 40, y: 40), size: item.size), styleMask: [.borderless],
        backing: .buffered, defer: false)
      window.contentView = NSHostingView(rootView: OverlayView(model: model))
      window.orderFrontRegardless()
      let start = Date.now
      for (index, at) in item.frames.enumerated() {
        let wait = at - Date.now.timeIntervalSince(start)
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        let suffix = item.frames.count > 1 ? "-\(Int(at * 1000))ms" : ""
        shoot(window, "\(directory)/\(item.name)\(suffix).png", wait: index == item.frames.count - 1)
      }
      window.orderOut(nil)
    }

    private static func appearanceWindow(into directory: String) async {
      let store = ReceiverStore(
        endpoints: Endpoints(server: URL(string: "http://127.0.0.1:9")!, web: URL(string: "http://127.0.0.1:9")!),
        persistence: NoPersistence())
      let window = NSWindow(
        contentRect: NSRect(x: 40, y: 40, width: 760, height: 760), styleMask: [.titled], backing: .buffered,
        defer: false)
      window.title = "Tap Appearance"
      window.contentView = NSHostingView(rootView: AppearanceView(store: store))
      window.orderFrontRegardless()
      try? await Task.sleep(for: .seconds(1.5))
      shoot(window, "\(directory)/appearance-window.png", wait: true)
      window.orderOut(nil)
    }

    /// Each first-run step at 1440×900, with no server: the account points
    /// nowhere and forgets nothing.
    private static func welcomeSteps(into directory: String) async {
      let account = AccountStore(server: URL(string: "http://127.0.0.1:9")!, vault: NoVault())
      let steps: [(String, WelcomeModel.Step)] = [
        ("welcome", .welcome), ("email", .email), ("code", .code), ("you", .you), ("ready", .ready),
      ]
      for (name, step) in steps {
        let model = WelcomeModel(pointerX: 1240, menuBarHeight: 0, account: account, sync: {}, dismiss: { _ in })
        model.step = step
        model.email = "jake@example.com"
        model.code = step == .code ? "1234" : ""
        model.name = "Jake"
        model.color = .moss
        let window = NSWindow(
          contentRect: NSRect(x: 40, y: 40, width: 1440, height: 900), styleMask: [.borderless], backing: .buffered,
          defer: false)
        window.contentView = NSHostingView(rootView: WelcomeView(model: model))
        window.orderFrontRegardless()
        try? await Task.sleep(for: .seconds(1.5))
        // Drawn from the view itself: needs no Screen Recording permission.
        if let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
          view.cacheDisplay(in: view.bounds, to: rep)
          try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(directory)/mac-\(name).png"))
        }
        window.orderOut(nil)
      }
    }

    private static func shoot(_ window: NSWindow, _ path: String, wait: Bool) {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
      process.arguments = ["-x", "-o", "-l", "\(window.windowNumber)", path]
      try? process.run()
      if wait { process.waitUntilExit() }
    }

    private struct NoVault: CredentialVault {
      func read() -> String? { nil }
      func write(_ token: String) throws {}
      func delete() {}
    }

    private final class NoPersistence: ReceiverPersistence, @unchecked Sendable {
      func loadCredential() -> String? { nil }
      func saveCredential(_ token: String) throws {}
      func deleteCredential() {}
      func loadPendingAcks() -> [String: TapResponse] { [:] }
      func savePendingAcks(_ acks: [String: TapResponse]) {}
    }
  }
#endif
