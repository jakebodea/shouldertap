import Foundation

// Sign in a second device with a QR code (docs/onboarding.md, "Sign in with a
// QR code"). Computer → phone: a signed-in device shows `QrSignIn.url`; the
// phone redeems the token. Phone → computer: a signed-out device starts a
// `DeviceSignIn` and shows its `url`; a signed-in phone reviews and approves
// the user code in it. Mirrors packages/client/src/account.ts.

/// A QR code a signed-in device shows for another to scan and sign in.
public struct QrSignIn: Decodable, Sendable, Hashable {
  public var token: String
  /// `https://shouldertap.app/qr#<token>`; draw this.
  public var url: String
  /// Milliseconds since 1970.
  public var expiresAt: Timestamp
}

/// Whether a `QrSignIn` was scanned.
public struct QrSignInStatus: Decodable, Sendable, Hashable {
  public enum State: String, Decodable, Sendable { case pending, used, expired }
  public var status: State
  /// The `platform` the scanning device sent, once used.
  public var platform: String?

  /// Who scanned it, named the way people say it.
  public var device: SignInDevice? { platform.flatMap(SignInDevice.init(platform:)) }
}

/// The kind of device a sign-in is for. `rawValue` is how people say it:
/// "Signed in on your iPhone", "Sign in on your PC?".
public enum SignInDevice: String, Sendable, Hashable {
  case iPhone, Mac, PC, browser

  /// From a `/account/sync` platform (`iphone`, `mac`, `windows`, `web`).
  public init?(platform: String) {
    switch platform {
    case "iphone": self = .iPhone
    case "mac": self = .Mac
    case "windows": self = .PC
    case "web": self = .browser
    default: return nil
    }
  }

  /// From a device authorization `client_id`.
  public init?(client: String) {
    guard let client = DeviceClient(rawValue: client) else { return nil }
    switch client {
    case .ios: self = .iPhone
    case .mac: self = .Mac
    case .windows: self = .PC
    case .web: self = .browser
    }
  }
}

/// The device authorization `client_id`s the server accepts.
public enum DeviceClient: String, Sendable {
  case ios = "shouldertap-ios"
  case mac = "shouldertap-mac"
  case windows = "shouldertap-windows"
  case web = "shouldertap-web"
}

/// A signed-out device asking a signed-in phone to approve it.
public struct DeviceSignIn: Sendable, Hashable {
  public var client: DeviceClient
  public var deviceCode: String
  /// Show it big under the QR code, so the phone's confirmation can be checked against it.
  public var userCode: String
  /// Show as the QR code; the phone reads `user_code` from it.
  public var url: String
  /// Seconds between polls.
  public var interval: Int
  public var expiresAt: Date
}

/// One poll of a `DeviceSignIn`.
public enum DeviceSignInPoll: Sendable, Hashable {
  /// Approved: this device is signed in (the session is in the vault).
  case signedIn
  /// Not yet; poll again after `interval` seconds.
  case pending(interval: Int)
  /// The phone said no.
  case denied
  /// Too late, or already used: show a new code.
  case expired
}

/// What a scanned device sign-in code would sign in, before approving it.
public struct DeviceSignInReview: Sendable, Hashable {
  public var userCode: String
  /// Nil for a client this build doesn't know.
  public var device: SignInDevice?
  /// Still waiting for an answer (not approved, denied or expired).
  public var pending: Bool
}

/// The token in a scanned sign-in QR code (`https://<host>/qr#<token>` or
/// `shouldertap://qr#<token>`), or nil for anything else.
public func qrSignInToken(from scanned: String) -> String? {
  let value = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
  let prefixes = ["shouldertap://qr#"]
  var token: Substring?
  if let prefix = prefixes.first(where: value.hasPrefix) {
    token = value.dropFirst(prefix.count)
  } else if value.hasPrefix("https://"), let hash = value.firstIndex(of: "#") {
    let base = value[value.index(value.startIndex, offsetBy: 8)..<hash]
    // One host, then exactly `/qr`.
    guard let slash = base.firstIndex(of: "/"), slash != base.startIndex,
      base[slash...] == "/qr"
    else { return nil }
    token = value[value.index(after: hash)...]
  }
  guard let token, (16...128).contains(token.count),
    token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
  else { return nil }
  return String(token)
}

/// The user code in a scanned device sign-in QR code
/// (`https://<host>/account/device?user_code=<code>`), or nil.
public func deviceSignInCode(from scanned: String) -> String? {
  guard let components = URLComponents(string: scanned.trimmingCharacters(in: .whitespacesAndNewlines)),
    components.scheme == "https", components.host?.isEmpty == false, components.path == "/account/device",
    let code = components.queryItems?.first(where: { $0.name == "user_code" })?.value, !code.isEmpty
  else { return nil }
  return code
}
