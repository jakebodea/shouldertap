import Foundation
import Security
import ShouldertapCore

/// Pairings (each holds a sender credential) live in the Keychain, one
/// generic-password item per recipient, readable after first unlock so a
/// future push handler can use them in the background, and never synced or
/// restored to another device. Outboxes are not secret: UserDefaults.
struct KeychainPersistence: SenderPersistence {
  private static let service = "app.shouldertap.sender.pairing"

  private var defaults: UserDefaults { .standard }

  func loadPairings() -> [SenderPairing] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnData as String: true,
      kSecReturnAttributes as String: true,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let items = result as? [[String: Any]]
    else { return [] }
    return items.compactMap { item in
      (item[kSecValueData as String] as? Data).flatMap { try? JSONDecoder().decode(SenderPairing.self, from: $0) }
    }
  }

  func savePairing(_ pairing: SenderPairing) throws {
    let data = try JSONEncoder().encode(pairing)
    let match: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: pairing.credentialId,
    ]
    let update: [String: Any] = [
      kSecValueData as String: data,
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

  func deletePairing(credentialId: String) {
    SecItemDelete(
      [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: Self.service,
        kSecAttrAccount as String: credentialId,
      ] as CFDictionary)
  }

  func loadOutbox(credentialId: String) -> [OutgoingTap] {
    guard let data = defaults.data(forKey: outboxKey(credentialId)) else { return [] }
    return (try? JSONDecoder().decode([OutgoingTap].self, from: data)) ?? []
  }

  func saveOutbox(_ outbox: [OutgoingTap], credentialId: String) {
    guard !outbox.isEmpty, let data = try? JSONEncoder().encode(outbox) else {
      defaults.removeObject(forKey: outboxKey(credentialId))
      return
    }
    defaults.set(data, forKey: outboxKey(credentialId))
  }

  private func outboxKey(_ credentialId: String) -> String { "outbox.v1.\(credentialId)" }
}
