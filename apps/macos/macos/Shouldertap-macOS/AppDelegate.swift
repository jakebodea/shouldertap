import AppKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

/// Menu-bar-only app: a status item with a React Native popover, plus
/// full-screen overlays (see `OverlayController`) when a tap arrives.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
  private static var instance: AppDelegate?

  static var shared: AppDelegate {
    guard let instance else { fatalError("AppDelegate not started") }
    return instance
  }

  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    instance = delegate
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }

  private let reactNativeDelegate = ReactNativeDelegate()
  private(set) var reactNativeFactory: RCTReactNativeFactory!
  private var statusItem: NSStatusItem!
  private let popover = NSPopover()

  func applicationDidFinishLaunching(_ notification: Notification) {
    let factory = RCTReactNativeFactory(delegate: reactNativeDelegate)
    reactNativeDelegate.dependencyProvider = RCTAppDependencyProvider()
    reactNativeFactory = factory

    // Creating the menu view boots the JS runtime right away, so the app
    // connects and can present overlays before the popover is ever opened.
    let menuView = makeRootView(moduleName: "MenuBar", properties: [:])
    let controller = NSViewController()
    controller.view = menuView
    controller.preferredContentSize = NSSize(width: 380, height: 600)
    popover.contentViewController = controller
    popover.contentSize = controller.preferredContentSize
    popover.behavior = .transient
    popover.animates = true

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = statusItem.button {
      button.image = Self.statusImage(pending: false)
      button.action = #selector(togglePopover(_:))
      button.target = self
    }

    let workspace = NSWorkspace.shared.notificationCenter
    workspace.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
    ) { _ in
      ShouldertapNative.emit("wake", body: nil)
    }
    workspace.addObserver(
      forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main
    ) { _ in
      ShouldertapNative.emit("wake", body: nil)
    }
  }

  /// Launching the app again (Finder, Spotlight, `open`) shows the menu.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openPopover()
    return false
  }

  func makeRootView(moduleName: String, properties: [String: Any]) -> NSView {
    reactNativeFactory.rootViewFactory.view(
      withModuleName: moduleName, initialProperties: properties)
  }

  @objc func togglePopover(_ sender: Any?) {
    popover.isShown ? closePopover() : openPopover()
  }

  func openPopover() {
    guard let button = statusItem.button else { return }
    NSApp.activate(ignoringOtherApps: true)
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
    ShouldertapNative.emit("popover", body: ["open": true])
  }

  func closePopover() {
    popover.performClose(nil)
  }

  var debugViews: [NSView] {
    popover.isShown ? [popover.contentViewController?.view].compactMap { $0 } : []
  }

  func setPending(_ pending: Bool) {
    statusItem.button?.image = Self.statusImage(pending: pending)
  }

  private static func statusImage(pending: Bool) -> NSImage? {
    let name = pending ? "hand.tap.fill" : "hand.tap"
    let image = NSImage(systemSymbolName: name, accessibilityDescription: "Shouldertap")
    image?.isTemplate = true
    return image
  }
}

// MARK: - React Native Delegate

final class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bundleURL()
  }

  override func bundleURL() -> URL? {
    #if DEBUG
      RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
      Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
