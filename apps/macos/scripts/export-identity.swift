// Export one code-signing identity (certificate and private key) from the
// login keychain as PKCS#12, for CI. macOS asks to allow the export.
//
//   swift apps/macos/scripts/export-identity.swift "<identity name>" <out.p12> <passphrase>
import Foundation
import Security

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
  FileHandle.standardError.write(Data("usage: export-identity.swift <name> <out.p12> <passphrase>\n".utf8))
  exit(2)
}
let (name, out, passphrase) = (arguments[1], arguments[2], arguments[3])

var result: CFTypeRef?
let query: [String: Any] = [
  kSecClass as String: kSecClassIdentity,
  kSecMatchLimit as String: kSecMatchLimitAll,
  kSecReturnRef as String: true,
]
guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
  let identities = result as? [SecIdentity],
  let identity = identities.first(where: { identity in
    var certificate: SecCertificate?
    SecIdentityCopyCertificate(identity, &certificate)
    return certificate.flatMap { SecCertificateCopySubjectSummary($0) as String? } == name
  })
else {
  FileHandle.standardError.write(Data("No identity named \(name)\n".utf8))
  exit(1)
}

var parameters = SecItemImportExportKeyParameters()
parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
parameters.passphrase = Unmanaged.passRetained(passphrase as CFString)
var data: CFData?
let status = SecItemExport(identity, .formatPKCS12, [], &parameters, &data)
guard status == errSecSuccess, let data else {
  FileHandle.standardError.write(Data("Export failed (\(status))\n".utf8))
  exit(1)
}
try (data as Data).write(to: URL(fileURLWithPath: out), options: .atomic)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: out)
