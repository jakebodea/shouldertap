import Foundation
import Security

/// Somewhere safer than a file to keep the Mac's credential.
public protocol CredentialVault: Sendable {
  func read() -> String?
  func write(_ token: String) throws
  func delete()
}

/// One generic-password item in the login Keychain. Its access list trusts
/// the app's designated requirement, so only builds signed by the same team
/// read it without a prompt: use it only from Developer ID builds.
public struct KeychainVault: CredentialVault {
  private let service: String
  private let account = "credential"

  public init(service: String) {
    self.service = service
  }

  private var match: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  public func read() -> String? {
    var query = match
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return String(decoding: data, as: UTF8.self).nilIfEmpty
  }

  public func write(_ token: String) throws {
    let update: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(match as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(match.merging(update) { $1 } as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw NSError(
        domain: NSOSStatusErrorDomain, code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "Couldn't save the pairing to the Keychain (\(status))."])
    }
  }

  public func delete() {
    SecItemDelete(match as CFDictionary)
  }
}

/// One owner-only file, for builds that can't use the Keychain without a
/// prompt after every update (ad-hoc signed).
public struct FileVault: CredentialVault {
  private let url: URL

  public init(url: URL) { self.url = url }

  public func read() -> String? {
    (try? String(contentsOf: url, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
  }

  public func write(_ token: String) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(token.utf8).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  public func delete() {
    try? FileManager.default.removeItem(at: url)
  }
}
