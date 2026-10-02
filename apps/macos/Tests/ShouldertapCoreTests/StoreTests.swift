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
  persistence: MemoryPersistence, platform: DevicePlatform = .mac, machine: String? = nil,
  handler: @escaping StubProtocol.Handler
) -> ReceiverStore {
  ReceiverStore(
    endpoints: Endpoints(server: URL(string: "https://api.test")!, web: URL(string: "https://web.test")!),
    persistence: persistence,
    deviceName: { platform == .mac ? "Test Mac" : "iPhone" },
    platform: platform,
    machine: { machine },
    session: StubProtocol.session(handler),
    ackRetryDelay: .milliseconds(50))
}

private func fixture(_ name: String) throws -> Data {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try Data(contentsOf: url)
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

  @Test func refreshPicksUpThePlan() async throws {
    let snapshot = String(decoding: try fixture("snapshot"), as: UTF8.self)
    let store = makeStore(persistence: MemoryPersistence(credential: "a.b.c")) { request in
      request.url!.path == "/v1/me" ? (200, snapshot) : (503, "")
    }
    store.start()
    #expect(store.plan == nil)
    store.refresh()
    #expect(await eventually { store.plan?.status == .trial })
  }

  @Test func checkoutOpensTheReturnedURL() async throws {
    let store = makeStore(persistence: MemoryPersistence(credential: "a.b.c")) { request in
      guard request.url!.path == "/v1/checkout", request.httpMethod == "POST" else { return (503, "") }
      return (201, #"{"url":"https://checkout.test/ch_1"}"#)
    }
    store.start()
    #expect(try await store.checkoutURL().absoluteString == "https://checkout.test/ch_1")
  }

  @Test func checkoutWhenAlreadyPaidRefreshesThePlan() async throws {
    let paid = String(decoding: try fixture("snapshot"), as: UTF8.self)
      .replacingOccurrences(of: #""status":"trial""#, with: #""status":"paid""#)
    let store = makeStore(persistence: MemoryPersistence(credential: "a.b.c")) { request in
      switch request.url!.path {
      case "/v1/checkout": (409, #"{"_tag":"Conflict","message":"Shouldertap is already unlocked for this inbox."}"#)
      case "/v1/me": (200, paid)
      default: (503, "")
      }
    }
    store.start()
    await #expect(throws: APIError.self) { try await store.checkoutURL() }
    #expect(await eventually { store.plan?.status == .paid })
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

  @Test(arguments: [String(repeating: "ab", count: 32), nil])
  func gettingStartedSendsTheMachineFingerprint(machine: String?) async throws {
    let sent = Sent()
    let store = makeStore(persistence: MemoryPersistence(), machine: machine) { request in
      guard request.url!.path == "/v1/inboxes" else { return (503, "") }
      sent.body = jsonBody(request)
      return (201, #"{"kind":"device","credentialId":"c1","token":"inbox.c1.secret","recipientName":"Jake"}"#)
    }
    store.start()
    try await store.createInbox(recipientName: "Jake")
    // Without a fingerprint the key is left out entirely, like older apps.
    var expected = ["recipientName": "Jake", "deviceName": "Test Mac"]
    expected["machine"] = machine
    #expect(sent.body == expected)
  }

  @Test func anIPhoneLinksAsAnIPhone() async throws {
    let sent = Sent()
    let persistence = MemoryPersistence()
    let store = makeStore(persistence: persistence, platform: .iphone) { request in
      guard request.url!.path == "/v1/invites/redeem" else { return (503, "") }
      sent.body = jsonBody(request)
      return (201, #"{"kind":"device","credentialId":"c2","token":"inbox.c2.secret","recipientName":"Jake"}"#)
    }
    store.start()
    try await store.join(code: " inbox.code1234.secret12 ")
    #expect(sent.body == ["code": "inbox.code1234.secret12", "name": "iPhone", "platform": "iphone"])
    #expect(persistence.loadCredential() == "inbox.c2.secret")
    #expect(store.phase == .ready)
  }

  /// The server keeps the last Mac while an iPhone is linked; so does the Mac.
  @Test func refusedSelfRemovalKeepsThePairing() async throws {
    let persistence = MemoryPersistence(credential: "inbox.dev1.secret")
    let store = makeStore(persistence: persistence) { request in
      switch request.url!.path {
      case "/v1/me": (200, String(decoding: try! fixture("snapshot"), as: UTF8.self))
      case "/v1/credentials/dev1":
        (409, #"{"_tag":"Conflict","message":"This is the only Mac on this inbox."}"#)
      default: (503, "")
      }
    }
    store.start()
    store.refresh()
    #expect(await eventually { store.credentialId == "dev1" })
    await #expect(throws: APIError.self) { try await store.revoke(credentialId: "dev1") }
    #expect(store.phase == .ready)
    #expect(persistence.loadCredential() == "inbox.dev1.secret")
  }
}

/// The last request body a stub saw.
final class Sent: @unchecked Sendable {
  private let lock = NSLock()
  private var _body: [String: String]?
  var body: [String: String]? {
    get { lock.withLock { _body } }
    set { lock.withLock { _body = newValue } }
  }
}

private func jsonBody(_ request: URLRequest) -> [String: String]? {
  guard let stream = request.httpBodyStream else { return nil }
  stream.open()
  defer { stream.close() }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count <= 0 { break }
    data.append(buffer, count: count)
  }
  return try? JSONDecoder().decode([String: String].self, from: data)
}
