import Foundation
import Observation

public struct AccountIdentity: Decodable, Identifiable, Sendable {
  public let id: String
  public let name: String
}
public struct AccountData: Decodable, Sendable {
  public let inboxes: [AccountIdentity]
  public let senders: [AccountIdentity]
  public let patrons: [AccountIdentity]
  public let defaultInboxId: String?
}
public struct DeviceAuthorization: Decodable, Sendable {
  public let device_code: String
  public let user_code: String
  public let verification_uri_complete: URL
  public let expires_in: Int
  public let interval: Int?
}
private struct AccountFailure: Decodable { let error: String?; let error_description: String?; let message: String? }
private struct AccountDeletion: Decodable { let success: Bool }
private struct AccountToken: Decodable { let access_token: String }
private struct AccountSession: Decodable { struct User: Decodable { let email: String }; let user: User }

/// Account sessions are separate from messaging credentials: signing out never unpairs a device.
@MainActor @Observable
public final class AccountStore {
  public private(set) var email: String?
  public private(set) var data: AccountData?
  public private(set) var authorization: DeviceAuthorization?
  public private(set) var busy = false
  public var error: String?
  public let server: URL
  private let clientID: String
  private let vault: any CredentialVault
  private let session: URLSession
  private let inboxVault: (String) -> any CredentialVault
  private var token: String?

  public init(server: URL, clientID: String, vault: any CredentialVault, session: URLSession = .shared, inboxVault: ((String) -> any CredentialVault)? = nil) {
    self.server = server; self.clientID = clientID; self.vault = vault; self.session = session
    self.inboxVault = inboxVault ?? { id in KeychainVault(service: "app.shouldertap.account.\(clientID).inbox.\(id)") }
    token = vault.read()
  }
  public func refresh() async {
    guard token != nil else { return }
    do {
      let current: AccountSession = try await request("GET", "/api/auth/get-session")
      email = current.user.email
      data = try await request("GET", "/account/data")
    } catch {
      if let failure = error as? DevicePollError, failure.status == 401 {
        vault.delete(); token = nil; email = nil; data = nil
      }
      self.error = error.localizedDescription
    }
  }
  public func begin() async -> URL? {
    guard !busy else { return nil }
    busy = true; error = nil
    defer { busy = false }
    do {
      let code: DeviceAuthorization = try await request("POST", "/api/auth/device/code", body: ["client_id": clientID])
      authorization = code
      return code.verification_uri_complete
    } catch { self.error = error.localizedDescription; return nil }
  }
  public func cancel() { authorization = nil }
  public func finishSignIn() async {
    guard let code = authorization else { return }
    let deadline = Date().addingTimeInterval(TimeInterval(code.expires_in))
    var interval = max(code.interval ?? 5, 1)
    do {
      while Date() < deadline, authorization?.device_code == code.device_code {
        try await Task.sleep(for: .seconds(interval))
        try Task.checkCancellation()
        guard authorization?.device_code == code.device_code else { return }
        guard Date() < deadline else { throw DevicePollError(code: "expired_token") }
        do {
          let result: AccountToken = try await request("POST", "/api/auth/device/token", body: [
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": code.device_code, "client_id": clientID])
          try Task.checkCancellation()
          guard authorization?.device_code == code.device_code else { return }
          try vault.write(result.access_token)
          token = result.access_token
          await refresh()
          // AccountView keys the polling task by authorization. Clearing it
          // cancels that task, so finish loading the session first.
          authorization = nil
          return
        } catch let failure as DevicePollError {
          switch failure.code {
          case "authorization_pending": continue
          case "slow_down": interval += 5
          default: throw failure
          }
        }
      }
      if authorization?.device_code == code.device_code { throw DevicePollError(code: "expired_token") }
    } catch is CancellationError { return }
    catch { self.error = error.localizedDescription; authorization = nil }
  }
  public func adopt(tokens: [String]) async {
    do { data = try await request("POST", "/account/adopt", body: ["tokens": tokens]) }
    catch { self.error = error.localizedDescription }
  }
  public func restore(kind: String, id: String, deviceName: String, platform: String) async throws -> CredentialGrant {
    try await request("POST", "/account/restore", body: ["kind": kind, "id": id, "deviceName": deviceName, "platform": platform])
  }
  /// Keep the original inbox recoverable before changing this device's active inbox.
  public func receiveInbox(id: String, inbox: ReceiverStore, deviceName: String, platform: String) async throws {
    guard inbox.pendingAcks.isEmpty else {
      throw DevicePollError(code: "Wait for your pending replies to send before switching inboxes.")
    }
    if let original = inbox.accountCredential {
      let attached: AccountData = try await request("POST", "/account/adopt", body: ["tokens": [original]])
      guard let originalID = tokenInboxId(original), attached.inboxes.contains(where: { $0.id == originalID }) else {
        throw DevicePollError(code: "Attach the current inbox to your account before switching.")
      }
      data = attached
      // Preserve the exact local credential too; switching never revokes it.
      try inboxVault(originalID).write(original)
    }
    let current: AccountData = try await request("GET", "/account/data")
    data = current
    guard current.inboxes.contains(where: { $0.id == id }) else {
      throw DevicePollError(code: "This inbox is not attached to your account.")
    }
    if let saved = inboxVault(id).read(), tokenInboxId(saved) == id {
      do {
        if case let .receiver(snapshot) = try await APIClient(baseURL: server, token: saved, session: session).me() {
          try inbox.restoreAccountInbox(CredentialGrant(kind: .device, credentialId: snapshot.credentialId,
            token: saved, recipientName: snapshot.recipientName))
          return
        }
        throw DevicePollError(code: "Saved inbox credential is not a receiver credential.")
      } catch let failure as APIError where failure.code == .unauthorized {
        inboxVault(id).delete()
      }
    }
    let grant = try await restore(kind: "inbox", id: id, deviceName: deviceName, platform: platform)
    try inboxVault(id).write(grant.token)
    try inbox.restoreAccountInbox(grant)
  }
  public func setDefault(_ id: String) async {
    do { data = try await request("POST", "/account/default", body: ["inboxId": id]) }
    catch { self.error = error.localizedDescription }
  }
  public func deleteAccount() async {
    guard !busy else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      let result: AccountDeletion = try await request("POST", "/api/auth/delete-user", body: [String: String]())
      guard result.success else { throw DevicePollError(code: "Account deletion was not completed. Please sign in again and retry.") }
      vault.delete(); token = nil; email = nil; data = nil; authorization = nil
    } catch { self.error = error.localizedDescription }
  }
  public func signOut() async {
    do {
      let _: [String: Bool] = try await request("POST", "/api/auth/sign-out", body: [String: String]())
      vault.delete(); token = nil; email = nil; data = nil; error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func request<T: Decodable>(_ method: String, _ path: String) async throws -> T {
    try await request(method, path, body: Optional<[String: String]>.none)
  }
  private func request<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
    var request = URLRequest(url: server.appending(path: path)); request.httpMethod = method; request.timeoutInterval = 20
    if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (bytes, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let failure = try? JSONDecoder().decode(AccountFailure.self, from: bytes)
      throw DevicePollError(code: failure?.error ?? failure?.message ?? "Request failed. Please try again.", status: status)
    }
    return try JSONDecoder().decode(T.self, from: bytes)
  }
}
private struct DevicePollError: LocalizedError {
  let code: String
  var status: Int = 0
  var errorDescription: String? {
    switch code {
    case "expired_token": "This sign-in code expired. Start again."
    case "access_denied": "Sign-in was declined."
    default: code
    }
  }
}
