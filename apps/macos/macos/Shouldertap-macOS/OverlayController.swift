import AppKit
import React

/// Borderless window that sits above other apps, including full-screen ones,
/// and can take keyboard focus for a typed reply.
final class OverlayWindow: NSWindow {
  init(screen: NSScreen) {
    super.init(
      contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    level = .screenSaver
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    isReleasedWhenClosed = false
    animationBehavior = .none
    setFrame(screen.frame, display: false)
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

/// Presents one interactive overlay per connected display for the current
/// tap and tears them all down together. Holds no protocol policy: JS decides
/// what to show and when to hide.
final class OverlayController {
  static let shared = OverlayController()

  private var windows: [(window: OverlayWindow, rootView: NSView, screen: NSScreen)] = []
  private var payload: [String: Any]?

  private init() {
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.displaysChanged()
    }
  }

  var isShowing: Bool { payload != nil }

  var debugViews: [NSView] { windows.compactMap { $0.window.contentView } }

  func show(_ payload: [String: Any]) {
    self.payload = payload
    if windows.isEmpty || !matchesCurrentScreens() {
      rebuild()
    } else {
      for (index, entry) in windows.enumerated() {
        Self.setAppProperties(
          entry.rootView, properties(screenIndex: index, screen: entry.screen))
      }
    }
    focus()
  }

  func hide() {
    payload = nil
    tearDown()
  }

  private func displaysChanged() {
    guard payload != nil else { return }
    rebuild()
    focus()
  }

  private func matchesCurrentScreens() -> Bool {
    let current = NSScreen.screens
    return current.count == windows.count
      && zip(current, windows).allSatisfy { $0.frame == $1.screen.frame }
  }

  private func rebuild() {
    tearDown()
    for (index, screen) in NSScreen.screens.enumerated() {
      let window = OverlayWindow(screen: screen)
      let container = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
      container.autoresizingMask = [.width, .height]

      let blur = NSVisualEffectView(frame: container.bounds)
      blur.autoresizingMask = [.width, .height]
      blur.material = .fullScreenUI
      blur.blendingMode = .behindWindow
      blur.state = .active
      container.addSubview(blur)

      let rootView = AppDelegate.shared.makeRootView(
        moduleName: "Overlay", properties: properties(screenIndex: index, screen: screen))
      rootView.frame = container.bounds
      rootView.autoresizingMask = [.width, .height]
      // Bridgeless root views are proxies, not RCTRootView; set through KVC.
      if rootView.responds(to: NSSelectorFromString("setBackgroundColor:")) {
        rootView.setValue(NSColor.clear, forKey: "backgroundColor")
      }
      container.addSubview(rootView)

      window.contentView = container
      window.orderFrontRegardless()
      windows.append((window, rootView, screen))
    }
  }

  private static func setAppProperties(_ view: NSView, _ properties: [String: Any]) {
    if view.responds(to: NSSelectorFromString("setAppProperties:")) {
      view.setValue(properties, forKey: "appProperties")
    }
  }

  private func tearDown() {
    for entry in windows {
      entry.window.orderOut(nil)
      entry.window.contentView = nil
    }
    windows.removeAll()
  }

  /// Give keyboard focus to the overlay on the display with the pointer.
  private func focus() {
    NSApp.activate(ignoringOtherApps: true)
    let mouse = NSEvent.mouseLocation
    let target =
      windows.first { NSMouseInRect(mouse, $0.screen.frame, false) } ?? windows.first
    target?.window.makeKeyAndOrderFront(nil)
  }

  private func properties(screenIndex: Int, screen: NSScreen) -> [String: Any] {
    let mouse = NSEvent.mouseLocation
    return [
      "tap": payload ?? [:],
      "screenIndex": screenIndex,
      "isFocused": NSMouseInRect(mouse, screen.frame, false),
    ]
  }
}
