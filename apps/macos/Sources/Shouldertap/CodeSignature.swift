import Foundation
import Security

/// How this running copy of the app is signed.
enum CodeSignature {
  /// The Apple team that signed the app; nil for ad-hoc and unsigned builds,
  /// whose signature changes with every build.
  static let teamIdentifier: String? = {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard
      SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
        == errSecSuccess,
      let info = info as? [String: Any]
    else { return nil }
    return info[kSecCodeInfoTeamIdentifier as String] as? String
  }()
}
