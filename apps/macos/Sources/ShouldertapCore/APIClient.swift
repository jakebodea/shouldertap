import Foundation

/// A failed API call with a stable `code`, mirroring `ApiError` in
/// packages/client/src/api.ts.
public struct APIError: Error, Sendable, LocalizedError {
  public enum Code: String, Sendable {
    case invalidRequest, unauthorized, paymentRequired, notFound, conflict, expired, rateLimited
    /// The server said a dependency (e.g. payments) isn't available.
    case unavailable
    case network
  }

  public var code: Code
  public var message: String
  public var status: Int

  public var errorDescription: String? {
    code == .network ? "Couldn't reach Shouldertap. Check your connection." : message
  }

  /// Transport failures and server errors are worth retrying; typed domain
  /// failures (not found, invalid, …) are not.
  public var isRetryable: Bool { code == .network || status >= 500 }

  static func from(status: Int, body: Data) -> APIError {
    let decoded = try? JSONDecoder().decode(ErrorBody.self, from: body)
    let message = decoded?.message ?? "Request failed (\(status))"
    let code: Code =
      switch status {
      case 400: .invalidRequest
      case 401: .unauthorized
      case 402: .paymentRequired
      case 404: .notFound
      case 409: .conflict
      case 410: .expired
      case 429: .rateLimited
      // Only the server's own 503 carries a message worth showing; a proxy's
      // is just the network.
      case 503 where decoded?.tag == "Unavailable": .unavailable
      default: .network
      }
    return APIError(code: code, message: message, status: status)
  }

  private struct ErrorBody: Decodable {
    var tag: String?
    var message: String

    private enum CodingKeys: String, CodingKey {
      case tag = "_tag"
      case message
    }
  }
}

/// The HTTP half of the protocol (see `ShouldertapApi` in
/// packages/domain/src/api.ts). Realtime events arrive over `LiveConnection`.
public struct APIClient: Sendable {
  public let baseURL: URL
  public let token: String?
  private let session: URLSession

  public init(baseURL: URL, token: String? = nil, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  public func withToken(_ token: String?) -> APIClient {
    APIClient(baseURL: baseURL, token: token, session: session)
  }

  // Pairing

  /// `machine` is this Mac's `MachineFingerprint`, so setting up again keeps
  /// the Mac's original trial; nil when it couldn't be read.
  public func createInbox(recipientName: String, deviceName: String, machine: String? = nil) async throws
    -> CredentialGrant
  {
    try await send(
      "POST", "/v1/inboxes",
      body: CreateInbox(recipientName: recipientName, deviceName: deviceName, machine: machine))
  }

  /// `color` is the sender's frame color; the server ignores it for Macs.
  public func redeemInvite(code: String, name: String, color: PersonColor? = nil) async throws
    -> CredentialGrant
  {
    try await send("POST", "/v1/invites/redeem", body: Redeem(code: code, name: name, color: color))
  }

  // Inbox (authorized)

  public func me() async throws -> Snapshot {
    try await send("GET", "/v1/me")
  }

  public func createInvite(kind: CredentialKind) async throws -> Invite {
    try await send("POST", "/v1/invites", body: ["kind": kind.rawValue])
  }

  /// Senders only. `requestId` makes retries idempotent: the same id and body
  /// always return the same tap; the same id with a different body is a conflict.
  public func sendTap(requestId: String, body: String) async throws -> Tap {
    try await send("POST", "/v1/taps", body: ["requestId": requestId, "body": body])
  }

  public func markDisplayed(tapId: String) async throws -> Tap {
    try await send("POST", "/v1/taps/\(escape(tapId))/displayed")
  }

  public func acknowledge(tapId: String, response: TapResponse) async throws -> Tap {
    try await send("POST", "/v1/taps/\(escape(tapId))/acknowledge", body: Acknowledge(response: response))
  }

  public func revoke(credentialId: String) async throws {
    let _: Revoked = try await send("DELETE", "/v1/credentials/\(escape(credentialId))")
  }

  /// Permanently removes this sender's pairing, messages and replies.
  public func deleteSender() async throws {
    let _: Deleted = try await send("DELETE", "/v1/sender")
  }

  /// Macs only: where to pay for this inbox. `conflict` once it's already
  /// paid for; `unavailable` when the server has no payments set up.
  public func createCheckout() async throws -> Checkout {
    try await send("POST", "/v1/checkout")
  }

  public func connectTicket() async throws -> ConnectTicket {
    try await send("POST", "/v1/connect-tickets")
  }

  /// `ws(s)://…/v1/connect?ticket=…`: the one-time ticket keeps the long-lived
  /// credential out of URLs.
  public func socketURL(ticket: String) -> URL? {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    components?.path = baseURL.path.trimmingSuffix("/") + "/v1/connect"
    components?.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
    return components?.url
  }

  // Transport

  private struct Acknowledge: Encodable { var response: TapResponse }
  private struct CreateInbox: Encodable {
    var recipientName: String
    var deviceName: String
    var machine: String?  // omitted when nil, like the optional key in the contract
  }
  private struct Redeem: Encodable {
    var code: String
    var name: String
    var color: PersonColor?  // omitted when nil, like the optional key in the contract
  }
  private struct Revoked: Decodable { var revoked: Bool }
  private struct Deleted: Decodable { var deleted: Bool }
  private struct NoBody: Encodable {}

  private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
    try await send(method, path, body: NoBody?.none)
  }

  private func send<Body: Encodable, Response: Decodable>(
    _ method: String, _ path: String, body: Body?
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.timeoutInterval = 20
    if let body {
      request.httpBody = try JSONEncoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw APIError(code: .network, message: error.localizedDescription, status: 0)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw APIError.from(status: status, body: data)
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      // The server answered with a shape we don't understand: treat as a
      // transient failure rather than acting on it.
      throw APIError(code: .network, message: "Unexpected response", status: status)
    }
  }

  private func escape(_ segment: String) -> String {
    segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? segment
  }
}

extension String {
  func trimmingSuffix(_ suffix: String) -> String {
    hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
  }
}
