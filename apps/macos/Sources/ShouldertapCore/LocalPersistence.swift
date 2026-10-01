import Foundation

/// The credential lives in the Keychain when a vault is given (Developer ID
/// builds), and otherwise in an owner-only file in
/// ~/Library/Application Support/Shouldertap: ad-hoc builds change signature
/// with every update, so the Keychain would prompt each time. A credential
/// left in the file by an older build moves into the vault on first read.
/// Unsent acknowledgements live in UserDefaults. Both locations match the
/// React Native app this replaced, so existing pairings carry over.
public struct LocalPersistence: ReceiverPersistence {
  private let directory: URL
  private let vault: (any CredentialVault)?
  /// nil is the app's standard defaults; tests pass their own suite.
  private let defaultsSuite: String?
  private static let pendingAcksKey = "pendingAcks"

  public init(
    directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appending(path: "Shouldertap", directoryHint: .isDirectory),
    defaultsSuite: String? = nil,
    vault: (any CredentialVault)? = nil
  ) {
    self.directory = directory
    self.defaultsSuite = defaultsSuite
    self.vault = vault
  }

  // UserDefaults is thread-safe but not Sendable, so resolve it per use.
  private var defaults: UserDefaults { defaultsSuite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

  private var credentialURL: URL { directory.appending(path: "credential.secret") }

  public func loadCredential() -> String? {
    guard let vault else { return fileCredential() }
    if let token = vault.read() { return token }
    guard let token = fileCredential() else { return nil }
    // Migrate; the file goes only once the Keychain holds the credential.
    if (try? vault.write(token)) != nil, vault.read() == token {
      deleteFile()
    }
    return token
  }

  public func saveCredential(_ token: String) throws {
    guard let vault else { return try writeFile(token) }
    try vault.write(token)
    deleteFile()
  }

  public func deleteCredential() {
    vault?.delete()
    deleteFile()
  }

  private func fileCredential() -> String? {
    guard let token = try? String(contentsOf: credentialURL, encoding: .utf8) else { return nil }
    return token.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  }

  private func writeFile(_ token: String) throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try Data(token.utf8).write(to: credentialURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credentialURL.path)
  }

  private func deleteFile() {
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
