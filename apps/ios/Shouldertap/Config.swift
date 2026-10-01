import Foundation

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

  /// Where the Mac app comes from, for the person being tapped.
  static let macDownloadPage = URL(string: "https://shouldertap.app/download")!
}
