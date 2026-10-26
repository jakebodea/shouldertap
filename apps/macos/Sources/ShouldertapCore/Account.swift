import Foundation
import Observation

// The account half of the client (docs/onboarding.md): sign in with an
// emailed code, set a name and color once, then `sync` keeps this device's
// inbox and sender keys in step with the account.

/// A person's name and color: how everyone they connect with sees them.
public struct Profile: Codable, Sendable, Hashable {
  public var name: String
  public var color: PersonColor

  public init(name: String, color: PersonColor) {
    self.name = name
    self.color = color
  }
}

/// `GET /account/me`.
public struct Me: Decodable, Sendable, Hashable {
  public var email: String
  /// Nil until the You step: ask for a name and color.
  public var profile: Profile?
  /// An inbox name an existing user already had, to prefill the You step.
  public var suggestedName: String?
  /// The person's inbox, once the profile exists.
  public var inboxId: String?
  /// How a new connection sees you unless you pick otherwise: the profile
  /// picked for your latest connection, else `profile`. Nil from older servers.
  public var sendProfile: Profile?
}

/// A sender key the account hands this device: tap `grant.recipientName` as
/// `name` in `color` (your own name and color, as they see you).
public struct SenderGrant: Decodable, Sendable {
  /// `${inboxId}:${credentialId}`.
  public var id: String
  public var grant: CredentialGrant
  public var name: String
  public var color: PersonColor
}

/// `POST /account/sync`.
public struct SyncResult: Decodable, Sendable {
  public var me: Me
  public var inbox: CredentialGrant?
  public var senders: [SenderGrant]
  public var removed: [String]
}

/// Who an invite is from, before accepting it (`GET /v1/invites/preview`).
public struct InvitePreview: Decodable, Sendable, Hashable {
  public var name: String
  public var color: PersonColor?
  public var expiresAt: Timestamp

  /// Their frame color, or a stable one for inviters who never picked.
  public var swatchColor: PersonColor { color ?? .fallback(for: name) }
}

/// `POST /account/accept`.
public struct Acceptance: Decodable, Sendable {
  public struct Person: Decodable, Sendable, Hashable {
    public var name: String
    public var color: PersonColor?
  }
  public var person: Person
  /// You → them; nil when you were already connected.
  public var sender: SenderGrant?
  /// They can tap you too.
  public var mutual: Bool
}

private struct AccountFailure: Decodable { let error: String?; let message: String? }
private struct AccountDeletion: Decodable { let success: Bool }
private struct SignedIn: Decodable { struct User: Decodable { let email: String }; let token: String; let user: User }

/// Account sessions are separate from messaging credentials: signing out never unpairs a device.
@MainActor @Observable
public final class AccountStore {
  public private(set) var email: String?
  public private(set) var me: Me?
  /// Where the last code went; the Code step is showing while this is set
  /// and the person isn't signed in.
  public private(set) var pendingEmail: String?
  public private(set) var busy = false
  public var error: String?
  /// New patron memberships can start (the server's public availability read).
  public private(set) var checkoutEnabled = false
  public var signedIn: Bool { token != nil }
  /// Signed in, but `me` hasn't loaded yet.
  public var isLoading: Bool { token != nil && me == nil && error == nil }
  public let server: URL
  private let vault: any CredentialVault
  private let session: URLSession
  private var token: String?
  @ObservationIgnored private var syncing: Task<Void, Never>?
  @ObservationIgnored private var syncAgain = false

  public init(server: URL, vault: any CredentialVault, session: URLSession = .shared) {
    self.server = server; self.vault = vault; self.session = session
    token = vault.read()
  }

  // MARK: Sign in

  /// Emails a six-digit code. A second call sends a new one.
  @discardableResult
  public func sendCode(email: String) async -> Bool {
    let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isEmail(email) else { error = "Enter your email address."; return false }
    guard !busy else { return false }
    busy = true; error = nil
    defer { busy = false }
    do {
      let _: [String: Bool] = try await request(
        "POST", "/api/auth/email-otp/send-verification-otp", body: ["email": email, "type": "sign-in"], auth: false)
      pendingEmail = email
      return true
    } catch { report(error); return false }
  }

  /// Back to the Email step.
  public func changeEmail() { pendingEmail = nil; error = nil }

  /// Signs in with the code sent to `pendingEmail`, then loads `me`.
  @discardableResult
  public func verify(code: String) async -> Bool {
    let code = code.filter(\.isNumber)
    guard let email = pendingEmail, code.count == 6, !busy else { return false }
    busy = true; error = nil
    defer { busy = false }
    do {
      let result: SignedIn = try await request(
        "POST", "/api/auth/sign-in/email-otp", body: ["email": email, "otp": code], auth: false)
      try keep(session: result.token, email: result.user.email)
    } catch let failure as AccountError where failure.status == 400 {
      self.error = "That code didn’t work. Check it or send a new one."
      return false
    } catch { report(error); return false }
    await loadAfterSignIn()
    return true
  }

  // MARK: Sign in with a QR code

  private struct RedeemBody: Encodable { var token: String; var platform: DevicePlatform }

  /// Signs this device in with a QR code scanned from a signed-in device
  /// (whatever was scanned; see `qrSignInToken`), then loads `me`, exactly
  /// like a correct emailed code.
  @discardableResult
  public func signIn(scanned: String, platform: DevicePlatform) async -> Bool {
    guard let qr = qrSignInToken(from: scanned) else {
      error = "That isn’t a Shouldertap sign-in code."; return false
    }
    guard !busy else { return false }
    busy = true; error = nil
    defer { busy = false }
    do {
      let result: SignedIn = try await request(
        "POST", "/api/auth/qr-sign-in/redeem", body: RedeemBody(token: qr, platform: platform), auth: false)
      try keep(session: result.token, email: result.user.email)
    } catch { report(error); return false }
    await loadAfterSignIn()
    return true
  }

  /// A one-time QR code for another device to scan and sign in with; needs a session.
  public func createQrSignIn() async throws -> QrSignIn {
    do { return try await request("POST", "/api/auth/qr-sign-in/create", body: [String: String]()) }
    catch { expireIfUnauthorized(error); throw error }
  }

  /// Whether the code from `createQrSignIn` was scanned, and by what.
  public func qrSignInStatus(token qr: String) async throws -> QrSignInStatus {
    do { return try await request("POST", "/api/auth/qr-sign-in/status", body: ["token": qr]) }
    catch { expireIfUnauthorized(error); throw error }
  }

  private struct DeviceCode: Decodable {
    let device_code: String
    let user_code: String
    let verification_uri_complete: String
    let interval: Int
    let expires_in: Int
  }
  private struct DeviceToken: Decodable { let access_token: String }
  private struct DeviceReview: Decodable { let user_code: String; let client_id: String; let status: String }

  /// Starts signing this device in by a signed-in phone scanning its QR code.
  public func startDeviceSignIn(client: DeviceClient, now: Date = .now) async throws -> DeviceSignIn {
    let grant: DeviceCode = try await request(
      "POST", "/api/auth/device/code", body: ["client_id": client.rawValue], auth: false)
    return DeviceSignIn(
      client: client, deviceCode: grant.device_code, userCode: grant.user_code, url: grant.verification_uri_complete,
      interval: grant.interval, expiresAt: now.addingTimeInterval(TimeInterval(grant.expires_in)))
  }

  /// One poll of a device sign-in; call again after the `pending` interval.
  /// Approved signs this device in (session in the vault, `me` loaded), like
  /// a correct emailed code.
  public func pollDeviceSignIn(_ started: DeviceSignIn, interval: Int? = nil) async throws -> DeviceSignInPoll {
    let interval = interval ?? started.interval
    let result: DeviceToken
    do {
      result = try await request("POST", "/api/auth/device/token", body: [
        "client_id": started.client.rawValue,
        "device_code": started.deviceCode,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
      ], auth: false)
    } catch let failure as AccountError {
      switch failure.code {
      case "authorization_pending": return .pending(interval: interval)
      case "slow_down": return .pending(interval: interval + 5)
      case "access_denied": return .denied
      case "expired_token", "invalid_grant": return .expired
      default: throw failure
      }
    }
    try keep(session: result.access_token, email: nil)
    await loadAfterSignIn()
    return .signedIn
  }

  /// What a scanned device sign-in code would sign in; needs a session.
  public func reviewDeviceSignIn(userCode: String) async throws -> DeviceSignInReview {
    do {
      let review: DeviceReview = try await request(
        "GET", "/api/auth/device", query: [URLQueryItem(name: "user_code", value: userCode)])
      return DeviceSignInReview(
        userCode: review.user_code, device: SignInDevice(client: review.client_id), pending: review.status == "pending")
    } catch { expireIfUnauthorized(error); throw error }
  }

  /// Signs the device showing `userCode` in to this account.
  public func approveDeviceSignIn(userCode: String) async throws {
    do { let _: Ignored = try await request("POST", "/api/auth/device/approve", body: ["userCode": userCode]) }
    catch { expireIfUnauthorized(error); throw error }
  }

  /// Turns the device showing `userCode` away.
  public func denyDeviceSignIn(userCode: String) async throws {
    do { let _: Ignored = try await request("POST", "/api/auth/device/deny", body: ["userCode": userCode]) }
    catch { expireIfUnauthorized(error); throw error }
  }

  private struct Ignored: Decodable {}

  /// Every way of signing in ends here: the session goes in the vault.
  private func keep(session: String, email: String?) throws {
    try vault.write(session)
    token = session
    self.email = email
    pendingEmail = nil
  }

  /// Signed in either way; a failed load shows its error and `refresh` retries.
  private func loadAfterSignIn() async {
    if let current: Me = try? await request("GET", "/account/me") { apply(current) }
  }

  // MARK: The person

  /// Reloads `me` (and whether patron checkout is open).
  public func refresh() async {
    await loadAvailability()
    guard let sessionToken = token else { return }
    do {
      let current: Me = try await request("GET", "/account/me")
      guard token == sessionToken else { return }
      apply(current)
      error = nil
    } catch {
      guard token == sessionToken else { return }
      expireIfUnauthorized(error)
      report(error)
    }
  }

  /// The You step: name and color, used for every new connection.
  @discardableResult
  public func saveProfile(name: String, color: PersonColor) async -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...maxNameLength).contains(name.count) else {
      error = "Enter your name (up to \(maxNameLength) characters)."; return false
    }
    guard !busy else { return false }
    busy = true; error = nil
    defer { busy = false }
    do {
      apply(try await request("POST", "/account/profile", body: Profile(name: name, color: color)))
      return true
    } catch { expireIfUnauthorized(error); report(error); return false }
  }

  // MARK: This device

  /// Brings this device's keys in step with the account: a device credential
  /// for your inbox when `receive` is true, a sender key for each of your
  /// people, and drops connections that are gone. Calls made while one is
  /// running run once more after it.
  public func sync(platform: DevicePlatform, deviceName: String, inbox: ReceiverStore?, senders: SenderStore) async {
    guard token != nil, me?.profile != nil else { return }
    if let syncing {
      syncAgain = true
      await syncing.value
      return
    }
    let task = Task {
      repeat {
        syncAgain = false
        await runSync(platform: platform, deviceName: deviceName, inbox: inbox, senders: senders)
      } while syncAgain
    }
    syncing = task
    await task.value
    syncing = nil
  }

  private struct SyncBody: Encodable {
    var platform: DevicePlatform
    var deviceName: String
    var receive: Bool
    var tokens: [String]
  }

  private func runSync(platform: DevicePlatform, deviceName: String, inbox: ReceiverStore?, senders: SenderStore) async {
    let tokens = Array(([inbox?.accountCredential].compactMap { $0 } + senders.sessions.map(\.pairing.token)).prefix(50))
    do {
      let result: SyncResult = try await request("POST", "/account/sync", body: SyncBody(
        platform: platform, deviceName: safeDeviceName(deviceName, platform), receive: inbox != nil, tokens: tokens))
      apply(result.me)
      let removed = Set(result.removed)
      inbox?.drop(tokens: removed)
      senders.drop(tokens: removed)
      if let grant = result.inbox, let inbox {
        try? inbox.receive(grant)
      }
      for sender in result.senders {
        _ = try? senders.add(sender)
      }
    } catch { expireIfUnauthorized(error); report(error) }
  }

  // MARK: Invites

  /// Who sent `code`, to show before accepting. Needs no sign-in.
  public func previewInvite(code: String) async throws -> InvitePreview {
    guard let code = inviteCode(from: code) else { throw AccountError(code: "That doesn’t look like a Shouldertap invite link.") }
    return try await request("GET", "/v1/invites/preview", query: [URLQueryItem(name: "code", value: code)], auth: false)
  }

  private struct AcceptBody: Encodable {
    var code: String; var platform: DevicePlatform; var deviceName: String; var profile: Profile?
  }

  /// Connects you and the inviter both ways and keeps your new key to tap
  /// them. `profile` is how just they will see you; nil means `me.sendProfile`.
  public func accept(
    code: String, profile: Profile? = nil, platform: DevicePlatform, deviceName: String, senders: SenderStore
  ) async throws -> Acceptance {
    guard let code = inviteCode(from: code) else { throw AccountError(code: "That doesn’t look like a Shouldertap invite link.") }
    let result: Acceptance = try await request("POST", "/account/accept", body: AcceptBody(
      code: code, platform: platform, deviceName: safeDeviceName(deviceName, platform), profile: profile))
    if let sender = result.sender { try senders.add(sender) }
    return result
  }

  private struct SendProfileBody: Encodable { var id: String; var name: String; var color: PersonColor }

  /// Changes how one person you tap sees you, on every device; their screens
  /// restyle your taps, old ones too. Needs a connection the account owns.
  public func updateSendProfile(_ id: String, name: String, color: PersonColor, senders: SenderStore) async throws {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...maxNameLength).contains(name.count) else {
      throw AccountError(code: "Enter your name (up to \(maxNameLength) characters).")
    }
    guard let session = senders.session(id: id), let accountId = session.pairing.accountId else {
      throw AccountError(code: "No such person")
    }
    do {
      let saved: Profile = try await request(
        "POST", "/account/send-profile", body: SendProfileBody(id: accountId, name: name, color: color))
      session.seen(as: saved)
    } catch { expireIfUnauthorized(error); throw error }
  }

  private struct Removed: Decodable { let removed: Bool }

  /// Stops tapping someone on every device on the account, then forgets them
  /// here. Revoking just this device's key would come back on the next sync.
  /// A connection the account never had (an old pairing not synced yet) is
  /// unpaired the old way, by revoking this device's key.
  public func remove(_ id: String, senders: SenderStore) async throws {
    guard let pairing = senders.session(id: id)?.pairing else { return }
    guard let accountId = pairing.accountId else { senders.unpair(id: id); return }
    do {
      let _: Removed = try await request("POST", "/account/remove", body: ["id": accountId])
      senders.drop(tokens: [pairing.token])
    } catch let failure as AccountError where failure.status == 404 {
      senders.unpair(id: id)
    }
  }

  // MARK: Patron membership

  /// `GET /account/patron/status`: the account's memberships and whether new
  /// ones can start.
  public func patronStatus() async throws -> AccountPatrons {
    try await request("GET", "/account/patron/status")
  }

  private struct Link: Decodable { let url: URL }

  /// Where to pay for a membership, opened in the browser.
  public func patronCheckout() async throws -> URL {
    let link: Link = try await request("POST", "/account/patron/checkout", body: [String: String]())
    return link.url
  }

  /// The billing portal for the account's membership.
  public func patronManage() async throws -> URL {
    let link: Link = try await request("POST", "/account/patron/manage", body: [String: String]())
    return link.url
  }

  private struct PatronGrant: Decodable { let key: String }

  /// A patron key of this device's own for one of the account's memberships.
  public func restorePatronKey(id: String) async throws -> String {
    let grant: PatronGrant = try await request("POST", "/account/restore", body: ["kind": "patron", "id": id])
    return grant.key
  }

  // MARK: Leaving

  public func deleteAccount() async {
    guard !busy else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      let result: AccountDeletion = try await request("POST", "/api/auth/delete-user", body: [String: String]())
      guard result.success else { throw AccountError(code: "Account deletion was not completed. Please sign in again and retry.") }
      forgetSession()
    } catch { report(error) }
  }

  /// Signs out; this device's credentials stay.
  public func signOut() async {
    do {
      let _: [String: Bool] = try await request("POST", "/api/auth/sign-out", body: [String: String]())
      forgetSession()
      error = nil
    } catch { report(error) }
  }

  // MARK: Plumbing

  private func apply(_ current: Me) {
    me = current
    email = current.email
  }

  private func forgetSession() {
    vault.delete(); token = nil; email = nil; me = nil; pendingEmail = nil
  }

  /// Shows a failure; a canceled call (its view went away) isn't one.
  private func report(_ error: any Error) {
    guard !(error is CancellationError) else { return }
    self.error = error.localizedDescription
  }

  private func expireIfUnauthorized(_ error: any Error) {
    if let failure = error as? AccountError, failure.status == 401 { forgetSession() }
  }

  private func safeDeviceName(_ name: String, _ platform: DevicePlatform) -> String {
    String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)).nilIfEmpty
      ?? (platform == .iphone ? "iPhone" : platform == .windows ? "PC" : "Mac")
  }

  private struct Availability: Decodable { let checkoutEnabled: Bool }
  /// Public and unauthenticated: never sends the account session.
  private func loadAvailability() async {
    guard let availability: Availability = try? await request("GET", "/v1/patrons/availability", auth: false)
    else { return }
    checkoutEnabled = availability.checkoutEnabled
  }

  private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], auth: Bool = true)
    async throws -> T
  {
    try await request(method, path, body: Optional<[String: String]>.none, query: query, auth: auth)
  }

  /// Every account call goes through here, so none carries a cookie.
  private func request<T: Decodable, B: Encodable>(
    _ method: String, _ path: String, body: B?, query: [URLQueryItem] = [], auth: Bool = true
  ) async throws -> T {
    var url = server.appending(path: path)
    if !query.isEmpty { url.append(queryItems: query) }
    var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 20
    // The bearer is the session. A cookie saved from a sign-in response would
    // make the server treat this as a browser and refuse POSTs without an Origin.
    request.httpShouldHandleCookies = false
    if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if auth, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (bytes, response): (Data, URLResponse)
    do { (bytes, response) = try await session.data(for: request) }
    catch let failure as URLError where failure.code == .cancelled { throw CancellationError() }
    catch is CancellationError { throw CancellationError() }
    catch { throw AccountError(code: "network") }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let failure = try? JSONDecoder().decode(AccountFailure.self, from: bytes)
      throw AccountError(code: failure?.error ?? failure?.message ?? "Request failed. Please try again.", status: status)
    }
    do { return try JSONDecoder().decode(T.self, from: bytes) }
    catch { throw AccountError(code: "Request failed. Please try again.", status: status) }
  }
}

/// A failed account call; `status` is the HTTP status (0 for the network).
public struct AccountError: LocalizedError, Sendable {
  public let code: String
  public var status: Int = 0
  public var errorDescription: String? { accountMessage(code, status: status) }
}

/// What a person reads for an account failure: never raw server codes.
public func accountMessage(_ code: String, status: Int = 0) -> String {
  switch code {
  case "network": "Couldn’t reach Shouldertap. Check your connection and try again."
  case "Origin required", "Origin not allowed", "Forbidden": "That didn’t work. Try again."
  case "Sign in to continue", "unauthorized": "Your sign-in expired. Sign in again."
  default: status == 401 ? "Your sign-in expired. Sign in again." : code
  }
}

/// Loose on purpose: the server decides; this only catches typos like a missing @.
func isEmail(_ value: String) -> Bool {
  let parts = value.split(separator: "@", omittingEmptySubsequences: false)
  return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !value.contains(" ")
    && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
}
