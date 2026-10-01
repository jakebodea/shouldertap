import CryptoKit
import Foundation

/// Names a Mac for its one free trial (`MachineFingerprint` in
/// packages/domain/src/contracts.ts) without revealing its hardware UUID:
/// a salted SHA-256, so the value can't be reversed or matched against
/// identifiers other apps derive from the same UUID.
public enum MachineFingerprint {
  /// Shipping builds.
  public static let releaseSalt = "shouldertap-trial-v1:"
  /// Debug builds, so testing setup doesn't use up the developer's own trial.
  public static let debugSalt = "shouldertap-trial-debug-v1:"

  /// 64 lowercase hex characters, or nil for an empty hardware id.
  public static func make(hardwareUUID: String, salt: String) -> String? {
    guard !hardwareUUID.isEmpty else { return nil }
    return SHA256.hash(data: Data((salt + hardwareUUID).utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }
}
