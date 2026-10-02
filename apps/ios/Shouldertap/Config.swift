import Foundation
import ShouldertapCore

/// Debug builds talk to the local stack (`bun run dev`); the simulator
/// reaches the host's localhost directly. Release builds use production.
/// Override with the SHOULDERTAP_SERVER_URL environment variable (scheme
/// editor, or `SIMCTL_CHILD_SHOULDERTAP_SERVER_URL` with `simctl launch`).
enum Config {
  static let server: URL = {
    if let override = ProcessInfo.processInfo.environment["SHOULDERTAP_SERVER_URL"],
      let url = URL(string: override)
    {
      return url
    }
    #if DEBUG
      return URL(string: "http://localhost:3000")!
    #else
      return URL(string: "https://api.shouldertap.app")!
    #endif
  }()

  /// The sender site, where invite links you share from your inbox lead.
  static let web: URL = {
    if let override = ProcessInfo.processInfo.environment["SHOULDERTAP_WEB_URL"],
      let url = URL(string: override)
    {
      return url
    }
    #if DEBUG
      return URL(string: "http://localhost:3001")!
    #else
      return URL(string: "https://shouldertap.app")!
    #endif
  }()

  /// Your inbox's device credential, when this iPhone is linked to your Mac.
  /// In the Keychain like the sender pairings (readable after first unlock,
  /// never synced); unsent answers would go in UserDefaults, though a linked
  /// iPhone doesn't answer taps yet.
  static let inboxPersistence = LocalPersistence(
    vault: KeychainVault(service: "app.shouldertap.ios.inbox"))

  /// Where the Mac app comes from, for the person being tapped.
  static let macDownloadPage = URL(string: "https://shouldertap.app/download")!
}
