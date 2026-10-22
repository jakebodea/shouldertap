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
      #if targetEnvironment(simulator)
        // iOS relaunches the app on its own (a Live Activity token, a push),
        // without the variable: keep using the same server.
        UserDefaults.standard.set(override, forKey: "serverOverride")
      #endif
      return url
    }
    #if targetEnvironment(simulator)
      if let saved = UserDefaults.standard.string(forKey: "serverOverride"), let url = URL(string: saved) {
        return url
      }
    #endif
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

  /// Your inbox's device credential, issued by the account (`AccountStore.sync`).
  /// In the Keychain like the sender pairings (readable after first unlock,
  /// never synced); unsent answers persist in UserDefaults for retry.
  static let inboxPersistence = LocalPersistence(
    vault: KeychainVault(service: "app.shouldertap.iphone.inbox"))
}
