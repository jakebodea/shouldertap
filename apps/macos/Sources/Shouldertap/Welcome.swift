import AppKit
import ShouldertapCore
import SwiftUI

/// The first launch: a full-screen Frame in Cobalt, under the menu bar so the
/// real icon stays visible (and knocks), with a pointer at it and how to
/// start. Shown once, on the display that has the icon.
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
  func show(on screen: NSScreen, item: NSWindow, finished: @escaping (_ setUp: Bool) -> Void) {
    guard window == nil else { return }
    self.finished = finished
    let window = OverlayWindow(screen: screen)
    // Just under the menu bar, which stays live above it.
    window.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1)
    let menuBar = screen.frame.maxY - screen.visibleFrame.maxY
    let model = WelcomeModel(
      pointerX: Self.pointerX(item.frame, on: screen),
      menuBarHeight: menuBar > 0 ? menuBar : NSStatusBar.system.thickness,
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
  /// Where the menu bar icon is, in the window's coordinates; nil if hidden.
  var pointerX: CGFloat?
  let menuBarHeight: CGFloat
  let needsMove = Install.needsMove
  let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  var moveError: String?
  @ObservationIgnored let dismiss: (_ setUp: Bool) -> Void

  init(pointerX: CGFloat?, menuBarHeight: CGFloat, dismiss: @escaping (_ setUp: Bool) -> Void) {
    self.pointerX = pointerX
    self.menuBarHeight = menuBarHeight
    self.dismiss = dismiss
  }

  func moveToApplications() {
    do { try Install.moveToApplications() } catch { moveError = error.localizedDescription }
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

private let welcomeColor = PersonColor.cobalt

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
      .background(welcomeColor.base)
      .overlay(alignment: .topLeading) {
        if let x = model.pointerX {
          // Trailing edge half an arrow past the icon's center, so the arrow sits under it.
          MenuBarPointer(reduceMotion: model.reduceMotion)
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
    }
    .foregroundStyle(welcomeColor.ink)
    .padding(.top, 26)
    .padding(.horizontal, 72)
    .frame(height: 96, alignment: .topLeading)
  }

  private func page(scale: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      MessageText(text: "Welcome to Shouldertap.", size: (128 * scale).rounded())
        .rise(arrived, delay: 0.08, reduceMotion: model.reduceMotion)
      Text(
        "When someone you trust taps you on the shoulder, their message covers your screen, just like this, until you answer."
      )
      .font(Bricolage.medium(26))
      .foregroundStyle(Paper.tone)
      .lineSpacing(4)
      .frame(maxWidth: 820, alignment: .leading)
      .padding(.top, 28)
      .rise(arrived, delay: 0.16, reduceMotion: model.reduceMotion)

      Spacer(minLength: 40)

      HStack(alignment: .top, spacing: 14) {
        Step(
          number: 1, title: "Find the mark in your menu bar",
          detail: model.pointerX == nil
            ? "Shouldertap lives up there, not in the Dock. If you can't see it, make room in your menu bar."
            : "Shouldertap lives up there, not in the Dock.")
        Step(number: 2, title: "Set up this Mac", detail: "Add your name, so people know who they're tapping.")
        Step(number: 3, title: "Invite someone", detail: "Send them a link. When they tap, you'll know.")
      }
      .frame(maxWidth: 1100, alignment: .leading)
      .rise(arrived, delay: 0.26, reduceMotion: model.reduceMotion)

      actions
        .padding(.top, 40)
        .rise(arrived, delay: 0.34, reduceMotion: model.reduceMotion)
    }
    .padding(.vertical, 64)
    .padding(.horizontal, 72)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Paper.paper))
    .padding(.horizontal, 40)
    .padding(.bottom, 40)
  }

  @ViewBuilder private var actions: some View {
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
          Pill(icon: .mac, label: "Move to Applications", hint: "↩", fill: welcomeColor) {
            model.moveToApplications()
          }
          .keyboardShortcut(.defaultAction)
        } else {
          Pill(icon: .mac, label: "Set up this Mac", hint: "↩", fill: welcomeColor) { model.dismiss(true) }
            .keyboardShortcut(.defaultAction)
        }
        Pill(label: "Later", hint: "esc") { model.dismiss(false) }
          .keyboardShortcut(.cancelAction)
      }
    }
  }
}

/// One of the three steps: an answer card with a numbered avatar.
private struct Step: View {
  let number: Int
  let title: String
  let detail: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("\(number)")
        .font(Bricolage.bold(18))
        .foregroundStyle(welcomeColor.ink)
        .frame(width: 36, height: 36)
        .background(Circle().fill(welcomeColor.base))
        .padding(.bottom, 6)
      Text(title)
        .font(Bricolage.bold(22))
        .tracking(-0.44)
        .foregroundStyle(Paper.ink)
        .fixedSize(horizontal: false, vertical: true)
      Text(detail)
        .font(Bricolage.medium(17))
        .foregroundStyle(Paper.tone)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(24)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Paper.faint))
  }
}

/// An arrow up at the menu bar icon, with its label to the left; it bobs
/// gently unless Reduce Motion is on.
private struct MenuBarPointer: View {
  nonisolated static let arrowWidth: CGFloat = 28
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
    .foregroundStyle(welcomeColor.ink)
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
