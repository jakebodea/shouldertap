import AppKit
import CoreImage.CIFilterBuiltins
import React
import ServiceManagement

/// The narrow Mac platform interface exposed to TypeScript: overlays,
/// credential storage, small preferences, QR codes, login item and lifecycle events.
@objc(ShouldertapNative)
final class ShouldertapNative: RCTEventEmitter {
  private static weak var current: ShouldertapNative?
  private var hasListeners = false

  override init() {
    super.init()
    Self.current = self
  }

  override static func requiresMainQueueSetup() -> Bool { true }

  override var methodQueue: DispatchQueue! { .main }

  override func supportedEvents() -> [String]! { ["wake", "popover"] }

  override func startObserving() { hasListeners = true }

  override func stopObserving() { hasListeners = false }

  static func emit(_ name: String, body: Any?) {
    guard let module = current, module.hasListeners else { return }
    module.sendEvent(withName: name, body: body)
  }

  // MARK: Overlay

  @objc func showOverlay(_ payload: NSDictionary) {
    OverlayController.shared.show(payload as? [String: Any] ?? [:])
  }

  @objc func hideOverlay() {
    OverlayController.shared.hide()
  }

  // MARK: Debug

  /// Debug builds only: render the app's own overlay (or popover) views to
  /// PNG files so UI can be checked without screen-recording permission.
  @objc func debugSnapshot(
    _ directory: String, resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    #if DEBUG
      let views = OverlayController.shared.debugViews + AppDelegate.shared.debugViews
      var paths: [String] = []
      for (index, view) in views.enumerated() {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { continue }
        let path = "\(directory)/snapshot-\(index).png"
        if (try? png.write(to: URL(fileURLWithPath: path))) != nil { paths.append(path) }
      }
      resolve(paths)
    #else
      reject("debug", "Not available in release builds", nil)
    #endif
  }

  // MARK: Menu bar

  @objc func openPopover() {
    AppDelegate.shared.openPopover()
  }

  @objc func closePopover() {
    AppDelegate.shared.closePopover()
  }

  @objc func setPending(_ pending: Bool) {
    AppDelegate.shared.setPending(pending)
  }

  @objc func quit() {
    NSApp.terminate(nil)
  }

  // MARK: Device

  @objc func deviceName(
    _ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    resolve(Host.current().localizedName ?? "Mac")
  }

  @objc func copyToClipboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  @objc func qrCode(
    _ text: String, resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
    else {
      reject("qr", "Couldn't make a QR code", nil)
      return
    }
    let rep = NSCIImageRep(ciImage: output)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:])
    else {
      reject("qr", "Couldn't encode the QR code", nil)
      return
    }
    resolve("data:image/png;base64,\(png.base64EncodedString())")
  }

  // MARK: Launch at login

  @objc func launchAtLogin(
    _ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    resolve(SMAppService.mainApp.status == .enabled)
  }

  @objc func setLaunchAtLogin(
    _ enabled: Bool, resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      resolve(SMAppService.mainApp.status == .enabled)
    } catch {
      reject("login_item", error.localizedDescription, error)
    }
  }

  // MARK: Secrets (the device credential)
  //
  // Stored in an owner-only file rather than the Keychain for now: builds are
  // ad-hoc signed, so every rebuild would trip a Keychain access prompt.
  // Move to the Keychain once the app has a stable Developer ID signature.

  private static let secretsQueue = DispatchQueue(label: "app.shouldertap.secrets")

  private static func secretURL(_ key: String) throws -> URL {
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = support.appendingPathComponent("Shouldertap", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let safeKey = key.filter { $0.isLetter || $0.isNumber }
    return directory.appendingPathComponent("\(safeKey).secret")
  }

  @objc func getSecret(
    _ key: String, resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.secretsQueue.async {
      do {
        let url = try Self.secretURL(key)
        guard FileManager.default.fileExists(atPath: url.path) else {
          resolve(nil)
          return
        }
        resolve(try String(contentsOf: url, encoding: .utf8))
      } catch {
        reject("secret", error.localizedDescription, error)
      }
    }
  }

  @objc func setSecret(
    _ key: String, value: String, resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.secretsQueue.async {
      do {
        let url = try Self.secretURL(key)
        try Data(value.utf8).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        resolve(true)
      } catch {
        reject("secret", error.localizedDescription, error)
      }
    }
  }

  @objc func deleteSecret(
    _ key: String, resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Self.secretsQueue.async {
      if let url = try? Self.secretURL(key) {
        try? FileManager.default.removeItem(at: url)
      }
      resolve(true)
    }
  }

  // MARK: Preferences (non-secret state such as unsent acknowledgements)

  @objc func getItem(
    _ key: String, resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    resolve(UserDefaults.standard.string(forKey: key))
  }

  @objc func setItem(_ key: String, value: String?) {
    if let value {
      UserDefaults.standard.set(value, forKey: key)
    } else {
      UserDefaults.standard.removeObject(forKey: key)
    }
  }
}
