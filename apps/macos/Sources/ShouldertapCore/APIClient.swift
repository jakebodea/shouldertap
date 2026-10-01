import Foundation

/// A failed API call with a stable `code`, mirroring `ApiError` in
/// packages/client/src/api.ts.
public struct APIError: Error, Sendable, LocalizedError {
  public enum Code: String, Sendable {
    case invalidRequest, unauthorized, notFound, conflict, expired, rateLimited, network
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
    let message =
      (try? JSONDecoder().decode(ErrorBody.self, from: body))?.message ?? "Request failed (\(status))"
    let code: Code =
      switch status {
      case 400: .invalidRequest
      case 401: .unauthorized
      case 404: .notFound
      case 409: .conflict
      case 410: .expired
      case 429: .rateLimited
      default: .network
      }
    return APIError(code: code, message: message, status: status)
  }

  private struct ErrorBody: Decodable { var message: String }
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

  public func createInbox(recipientName: String, deviceName: String) async throws -> CredentialGrant {
    try await send("POST", "/v1/inboxes", body: ["recipientName": recipientName, "deviceName": deviceName])
  }

  public func redeemInvite(code: String, name: String) async throws -> CredentialGrant {
    try await send("POST", "/v1/invites/redeem", body: ["code": code, "name": name])
  }

  // Inbox (authorized)

  public func me() async throws -> Snapshot {
    try await send("GET", "/v1/me")
  }

  public func createInvite(kind: CredentialKind) async throws -> Invite {
    try await send("POST", "/v1/invites", body: ["kind": kind.rawValue])
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
  private struct Revoked: Decodable { var revoked: Bool }
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
