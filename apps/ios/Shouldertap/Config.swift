import Foundation
import Security
import ShouldertapCore

/// The verification launcher supplies both endpoints and a unique run ID.
/// Simulator OS relaunches retain that complete configuration until cleanup.
enum Config {
  private static let bootstrapKey = "verificationActiveRun"
  private static let launchEnvironment: [String: String] = {
    var env = ProcessInfo.processInfo.environment
    #if DEBUG
      let arguments = ProcessInfo.processInfo.arguments
      for (flag, key) in [
        ("--verify-run", "SHOULDERTAP_VERIFY_RUN"),
        ("--verify-api", "SHOULDERTAP_SERVER_URL"),
        ("--verify-web", "SHOULDERTAP_WEB_URL"),
        ("--verify-clear", "SHOULDERTAP_VERIFY_CLEAR"),
      ] {
        if let index = arguments.firstIndex(of: flag) {
          guard arguments.indices.contains(index + 1), !arguments[index + 1].hasPrefix("--")
          else { preconditionFailure("Missing value for \(flag)") }
          env[key] = arguments[index + 1]
        }
      }
    #endif
    return env
  }()
  static let verification: VerificationScope? = {
    #if DEBUG
      let env = launchEnvironment
      let explicit = env["SHOULDERTAP_VERIFY_RUN"]
      #if targetEnvironment(simulator)
        let runID = explicit ?? UserDefaults.standard.string(forKey: bootstrapKey)
      #else
        let runID = explicit
      #endif
      guard let runID else { return nil }
      guard let scope = try? VerificationScope(runID: runID) else {
        preconditionFailure("Invalid SHOULDERTAP_VERIFY_RUN")
      }
      #if targetEnvironment(simulator)
        if env["SHOULDERTAP_VERIFY_CLEAR"] == "1" {
          UserDefaults.standard.removePersistentDomain(forName: scope.namespace("app.shouldertap.iphone"))
          for base in ["app.shouldertap.iphone.account", "app.shouldertap.iphone.inbox", "app.shouldertap.sender.pairing"] {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword,
              kSecAttrService as String: scope.namespace(base)] as CFDictionary)
          }
          if UserDefaults.standard.string(forKey: bootstrapKey) == runID {
            UserDefaults.standard.removeObject(forKey: bootstrapKey)
          }
        }
      #endif
      return scope
    #else
      return nil
    #endif
  }()

  static var defaultsSuite: String? { verification?.namespace("app.shouldertap.iphone") }
  static var defaults: UserDefaults { defaultsSuite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }
  static func keychainService(_ base: String) -> String { verification?.namespace(base) ?? base }

  private static let endpoints: Endpoints = {
    let env = launchEnvironment
    #if DEBUG
      if let verification {
        let store = defaults
        let server = env["SHOULDERTAP_SERVER_URL"]
        let web = env["SHOULDERTAP_WEB_URL"]
        if server != nil || web != nil {
          guard let server, let web, let apiURL = URL(string: server), let webURL = URL(string: web),
            ["http", "https"].contains(apiURL.scheme), ["http", "https"].contains(webURL.scheme),
            apiURL.host != nil, webURL.host != nil
          else { preconditionFailure("Verification requires both valid server and web URLs") }
          if env["SHOULDERTAP_VERIFY_CLEAR"] == "1" {
            return Endpoints(server: apiURL, web: webURL)
          }
          store.set(["server": server, "web": web], forKey: "verificationEndpoints")
        }
        guard let saved = store.dictionary(forKey: "verificationEndpoints") as? [String: String],
          let server = saved["server"].flatMap(URL.init(string:)),
          let web = saved["web"].flatMap(URL.init(string:))
        else { preconditionFailure("Missing endpoints for verification run \(verification.runID)") }
        #if targetEnvironment(simulator)
          if env["SHOULDERTAP_VERIFY_RUN"] != nil {
            UserDefaults.standard.set(verification.runID, forKey: bootstrapKey)
          }
        #endif
        return Endpoints(server: server, web: web)
      }
    #endif
    // Preserve the existing debug/simulator endpoint override behavior.
    #if targetEnvironment(simulator)
      if let server = env["SHOULDERTAP_SERVER_URL"] {
        UserDefaults.standard.set(server, forKey: "serverOverride")
      }
      if let web = env["SHOULDERTAP_WEB_URL"] {
        UserDefaults.standard.set(web, forKey: "webOverride")
      }
      let serverOverride = env["SHOULDERTAP_SERVER_URL"] ?? UserDefaults.standard.string(forKey: "serverOverride")
      let webOverride = env["SHOULDERTAP_WEB_URL"] ?? UserDefaults.standard.string(forKey: "webOverride")
    #else
      let serverOverride = env["SHOULDERTAP_SERVER_URL"]
      let webOverride = env["SHOULDERTAP_WEB_URL"]
    #endif
    #if DEBUG
      let server = "http://localhost:3000"
      let web = "http://localhost:3001"
    #else
      let server = "https://api.shouldertap.app"
      let web = "https://shouldertap.app"
    #endif
    return Endpoints(server: URL(string: serverOverride ?? server)!, web: URL(string: webOverride ?? web)!)
  }()

  static var server: URL { endpoints.server }
  static var web: URL { endpoints.web }
  static let inboxPersistence = LocalPersistence(
    directory: verification?.directory(in: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Shouldertap", directoryHint: .isDirectory),
    defaultsSuite: defaultsSuite,
    vault: KeychainVault(service: keychainService("app.shouldertap.iphone.inbox")))
}
