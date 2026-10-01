import Foundation
import Testing

@testable import ShouldertapCore

/// Answers HTTP requests from a per-test handler instead of the network.
final class StubProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) -> (status: Int, body: String)
  private static let lock = NSLock()
  nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

  static func session(_ handler: @escaping Handler) -> URLSession {
    let id = UUID().uuidString
    lock.withLock { handlers[id] = handler }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    config.httpAdditionalHeaders = ["X-Stub": id]
    return URLSession(configuration: config)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let id = request.value(forHTTPHeaderField: "X-Stub") ?? ""
    guard let handler = Self.lock.withLock({ Self.handlers[id] }) else { return }
    let (status, body) = handler(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

final class MemoryPersistence: ReceiverPersistence, @unchecked Sendable {
  private let lock = NSLock()
  private var credential: String?
  private var acks: [String: TapResponse] = [:]

  init(credential: String? = nil, acks: [String: TapResponse] = [:]) {
    self.credential = credential
    self.acks = acks
  }

  func loadCredential() -> String? { lock.withLock { credential } }
  func saveCredential(_ token: String) throws { lock.withLock { credential = token } }
  func deleteCredential() { lock.withLock { credential = nil } }
  func loadPendingAcks() -> [String: TapResponse] { lock.withLock { acks } }
  func savePendingAcks(_ acks: [String: TapResponse]) { lock.withLock { self.acks = acks } }
}

/// Counts calls per path, for assertions about retries.
final class Calls: @unchecked Sendable {
  private let lock = NSLock()
  private var counts: [String: Int] = [:]

  func record(_ request: URLRequest) -> Int {
    lock.withLock {
      let key = request.url!.path
      counts[key, default: 0] += 1
      return counts[key]!
    }
  }

  func count(_ path: String) -> Int { lock.withLock { counts[path] ?? 0 } }
}

private let ackedTap = #"{"id":"t1","senderId":"s1","senderName":"Rosa","senderColor":"rose","body":"Hi","createdAt":1,"state":"acknowledged","displayedAt":1,"acknowledgedAt":2,"acknowledgedBy":"Test","response":{"kind":"on_it"},"sequence":2}"#

@MainActor
private func makeStore(
  persistence: MemoryPersistence, handler: @escaping StubProtocol.Handler
) -> ReceiverStore {
  ReceiverStore(
    endpoints: Endpoints(server: URL(string: "https://api.test")!, web: URL(string: "https://web.test")!),
    persistence: persistence,
    deviceName: { "Test Mac" },
    session: StubProtocol.session(handler),
    ackRetryDelay: .milliseconds(50))
}

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<100 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(20))
  }
  return condition()
}

@Suite(.serialized) @MainActor struct StoreBehavior {
  @Test func setupWhenUnpaired() {
    let store = makeStore(persistence: MemoryPersistence()) { _ in (500, "") }
    #expect(store.start() == false)
    #expect(store.phase == .setup)
  }

  @Test func answeringIsSavedThenSent() async {
    let persistence = MemoryPersistence(credential: "a.b.c")
    let calls = Calls()
    let store = makeStore(persistence: persistence) { request in
      _ = calls.record(request)
      if request.url!.path == "/v1/taps/t1/acknowledge" {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer a.b.c")
        return (200, ackedTap)
      }
      return (503, "")  // Keep the live socket offline.
    }
    store.start()
    store.respond(tapId: "t1", response: .onIt)
    #expect(store.pendingAcks["t1"] == .onIt)
    #expect(await eventually { store.pendingAcks.isEmpty })
    #expect(persistence.loadPendingAcks().isEmpty)
    #expect(store.taps.first?.state == .acknowledged)
  }

  @Test func offlineAnswersRetryUntilAccepted() async {
    let persistence = MemoryPersistence(credential: "a.b.c")
    let calls = Calls()
    let store = makeStore(persistence: persistence) { request in
      guard request.url!.path == "/v1/taps/t1/acknowledge" else { return (503, "") }
      return calls.record(request) < 3 ? (503, "") : (200, ackedTap)
    }
    store.start()
    store.respond(tapId: "t1", response: .in10)
    // Survives a restart while still unsent.
    #expect(persistence.loadPendingAcks() == ["t1": .in10])
    #expect(await eventually { store.pendingAcks.isEmpty })
    #expect(calls.count("/v1/taps/t1/acknowledge") == 3)
  }

  @Test func rejectedAnswersAreDropped() async {
    let persistence = MemoryPersistence(credential: "a.b.c")
    let store = makeStore(persistence: persistence) { request in
      request.url!.path == "/v1/taps/gone/acknowledge"
        ? (404, #"{"_tag":"NotFound","message":"No such tap"}"#) : (503, "")
    }
    store.start()
    store.respond(tapId: "gone", response: .onIt)
    #expect(await eventually { store.pendingAcks.isEmpty })
  }

  @Test func revokedCredentialReturnsToSetup() async {
    let persistence = MemoryPersistence(credential: "a.b.c")
    let store = makeStore(persistence: persistence) { request in
      request.url!.path == "/v1/connect-tickets" ? (401, #"{"_tag":"Unauthorized","message":"Revoked"}"#) : (503, "")
    }
    store.start()
    #expect(await eventually { store.phase == .setup })
    #expect(persistence.loadCredential() == nil)
  }

  @Test func senderInviteLinkCarriesTheCodeInTheFragment() async throws {
    let store = makeStore(persistence: MemoryPersistence(credential: "a.b.c")) { request in
      request.url!.path == "/v1/invites"
        ? (201, #"{"kind":"sender","code":"inbox.id.secret","expiresAt":1}"#) : (503, "")
    }
    store.start()
    let invite = try await store.createSenderInvite()
    #expect(invite.url.absoluteString == "https://web.test/join#inbox.id.secret")
  }
}
