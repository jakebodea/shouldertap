import AppKit
import SwiftUI

// Compiled alongside the existing Overlay, Theme, Icons and Core sources by capture-mac.sh.
@main
struct CaptureMac {
  @MainActor static func main() throws {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let root = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = URL(fileURLWithPath: CommandLine.arguments[2])
    let body = CommandLine.arguments[3]
    for font in try FileManager.default.contentsOfDirectory(at: root.appending(path: "apps/macos/Resources/Fonts"), includingPropertiesForKeys: nil) where font.pathExtension == "ttf" {
      CTFontManagerRegisterFontsForURL(font as CFURL, .process, nil)
    }
    let tap = Tap(id: "marketing-tap-01", senderId: "sender01", senderName: "Sam", senderColor: .moss,
                  body: body, createdAt: Date.now.timeIntervalSince1970 * 1000,
                  state: .pending, sequence: 1)
    let model = OverlayModel(active: ActiveTap(tap: tap, queued: 0), respond: { _, _ in })
    let view = NSHostingView(rootView: OverlayView(model: model))
    let size = NSSize(width: 1440, height: 900)
    let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -10000, y: -10000), size: size), styleMask: .borderless, backing: .buffered, defer: false)
    window.contentView = view
    window.orderFrontRegardless()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      view.layoutSubtreeIfNeeded()
      guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { fatalError("No bitmap") }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("No PNG") }
      do { try png.write(to: output) } catch { fatalError("Capture failed: \(error)") }
      app.terminate(nil)
    }
    app.run()
  }
}
