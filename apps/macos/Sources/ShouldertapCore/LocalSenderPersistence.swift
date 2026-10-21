import Foundation

/// The Mac's sender pairings, kept like its receiver credential
/// (`LocalPersistence`): every pairing as one JSON list in the vault when one
/// is given (Developer ID builds), otherwise in an owner-only
/// `senders.secret` beside `credential.secret`. Outboxes aren't secret:
/// UserDefaults, like the iPhone's.
public struct LocalSenderPersistence: SenderPersistence {
  private let directory: URL
  private let vault: (any CredentialVault)?
  /// nil is the app's standard defaults; tests pass their own suite.
  private let defaultsSuite: String?

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

  private var defaults: UserDefaults { defaultsSuite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

  private var fileURL: URL { directory.appending(path: "senders.secret") }

  public func loadPairings() -> [SenderPairing] {
    guard let json = vault?.read() ?? (try? String(contentsOf: fileURL, encoding: .utf8)),
      let pairings = try? JSONDecoder().decode([SenderPairing].self, from: Data(json.utf8))
    else { return [] }
    return pairings
  }

  public func savePairing(_ pairing: SenderPairing) throws {
    try write(loadPairings().filter { $0.credentialId != pairing.credentialId } + [pairing])
  }

  public func deletePairing(credentialId: String) {
    try? write(loadPairings().filter { $0.credentialId != credentialId })
  }

  private func write(_ pairings: [SenderPairing]) throws {
    guard !pairings.isEmpty else {
      vault?.delete()
      try? FileManager.default.removeItem(at: fileURL)
      return
    }
    let json = String(decoding: try JSONEncoder().encode(pairings), as: UTF8.self)
    if let vault { return try vault.write(json) }
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try Data(json.utf8).write(to: fileURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
  }

  public func loadOutbox(credentialId: String) -> [OutgoingTap] {
    guard let data = defaults.data(forKey: outboxKey(credentialId)) else { return [] }
    return (try? JSONDecoder().decode([OutgoingTap].self, from: data)) ?? []
  }

  public func saveOutbox(_ outbox: [OutgoingTap], credentialId: String) {
    guard !outbox.isEmpty, let data = try? JSONEncoder().encode(outbox) else {
      defaults.removeObject(forKey: outboxKey(credentialId))
      return
    }
    defaults.set(data, forKey: outboxKey(credentialId))
  }

  private func outboxKey(_ credentialId: String) -> String { "outbox.v1.\(credentialId)" }
}
