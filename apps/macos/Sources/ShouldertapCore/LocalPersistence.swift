import Foundation

/// The credential lives in an owner-only file in
/// ~/Library/Application Support/Shouldertap, not the Keychain: builds are
/// ad-hoc signed (no Developer ID), so the Keychain would prompt after every
/// update. Unsent acknowledgements live in UserDefaults. Both locations match
/// the React Native app this replaced, so existing pairings carry over.
public struct LocalPersistence: ReceiverPersistence {
  private let directory: URL
  /// nil is the app's standard defaults; tests pass their own suite.
  private let defaultsSuite: String?
  private static let pendingAcksKey = "pendingAcks"

  public init(
    directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appending(path: "Shouldertap", directoryHint: .isDirectory),
    defaultsSuite: String? = nil
  ) {
    self.directory = directory
    self.defaultsSuite = defaultsSuite
  }

  // UserDefaults is thread-safe but not Sendable, so resolve it per use.
  private var defaults: UserDefaults { defaultsSuite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

  private var credentialURL: URL { directory.appending(path: "credential.secret") }

  public func loadCredential() -> String? {
    guard let token = try? String(contentsOf: credentialURL, encoding: .utf8) else { return nil }
    return token.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  }

  public func saveCredential(_ token: String) throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try Data(token.utf8).write(to: credentialURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credentialURL.path)
  }

  public func deleteCredential() {
    try? FileManager.default.removeItem(at: credentialURL)
  }

  public func loadPendingAcks() -> [String: TapResponse] {
    guard let json = defaults.string(forKey: Self.pendingAcksKey),
      let acks = try? JSONDecoder().decode([String: TapResponse].self, from: Data(json.utf8))
    else { return [:] }
    return acks
  }

  public func savePendingAcks(_ acks: [String: TapResponse]) {
    guard !acks.isEmpty, let data = try? JSONEncoder().encode(acks) else {
      defaults.removeObject(forKey: Self.pendingAcksKey)
      return
    }
    defaults.set(String(decoding: data, as: UTF8.self), forKey: Self.pendingAcksKey)
  }
}
