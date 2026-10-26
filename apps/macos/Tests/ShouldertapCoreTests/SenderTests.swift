import Foundation
import Testing

@testable import ShouldertapCore

private func fixture(_ name: String) throws -> Data {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try Data(contentsOf: url)
}

final class MemorySenderPersistence: SenderPersistence, @unchecked Sendable {
  private let lock = NSLock()
  private var pairings: [String: SenderPairing]
  private var outboxes: [String: [OutgoingTap]] = [:]

  init(pairings: [SenderPairing] = []) {
    self.pairings = Dictionary(uniqueKeysWithValues: pairings.map { ($0.credentialId, $0) })
  }

  func loadPairings() -> [SenderPairing] { lock.withLock { Array(pairings.values) } }
  func savePairing(_ pairing: SenderPairing) throws { lock.withLock { pairings[pairing.credentialId] = pairing } }
  func deletePairing(credentialId: String) { lock.withLock { pairings[credentialId] = nil } }
  func loadOutbox(credentialId: String) -> [OutgoingTap] { lock.withLock { outboxes[credentialId] ?? [] } }
  func saveOutbox(_ outbox: [OutgoingTap], credentialId: String) { lock.withLock { outboxes[credentialId] = outbox } }
}

private let inbox = "inbox123"
private let code = "\(inbox).invite12.secret1234"
private let accountSender =
  #"{"id":"inbox123:s1","grant":{"kind":"sender","credentialId":"s1","token":"inbox123.s1s1s1s1.secret5678","recipientName":"Jamie"},"name":"Rosa","color":"plum"}"#

private func pairing(_ id: String = "s1s1s1s1", color: PersonColor? = .rose) -> SenderPairing {
  SenderPairing(
    token: "\(inbox).\(id).secret5678", credentialId: id, recipientName: "Jamie", senderName: "Rosa", color: color,
    pairedAt: 1)
}

private func sentTap(_ body: String) -> String {
  #"{"id":"t9","senderId":"s1","senderName":"Rosa","senderColor":"rose","body":"\#(body)","createdAt":5,"state":"pending","displayedAt":null,"acknowledgedAt":null,"acknowledgedBy":null,"response":null,"sequence":7}"#
}

private func body(_ request: URLRequest) -> [String: String] {
  (try? JSONDecoder().decode([String: String].self, from: rawBody(request))) ?? [:]
}

private func rawBody(_ request: URLRequest) -> Data {
  guard let stream = request.httpBodyStream else { return Data() }
  stream.open()
  defer { stream.close() }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count <= 0 { break }
    data.append(buffer, count: count)
  }
  return data
}

@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
  for _ in 0..<100 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(20))
  }
  return condition()
}

@MainActor
private func makeStore(_ persistence: MemorySenderPersistence, handler: @escaping StubProtocol.Handler)
  -> SenderStore
{
  SenderStore(server: URL(string: "https://api.test")!, persistence: persistence, session: StubProtocol.session(handler))
}

@Suite struct SenderContracts {
  @Test func decodesSenderSnapshot() throws {
    guard case let .sender(snapshot) = try JSONDecoder().decode(Snapshot.self, from: fixture("sender_snapshot"))
    else { Issue.record("expected a sender snapshot"); return }
    #expect(snapshot.recipientName == "Jamie")
    #expect(snapshot.senderColor == .rose)
    #expect(snapshot.taps.first?.response == .in10)
    #expect(snapshot.taps.last?.displayedAt != nil)
  }

  @Test(arguments: [
    code,
    "  \(code)\n",
    "https://shouldertap.app/join#\(code)",
    "http://localhost:3001/join#\(code)",
    "shouldertap://join#\(code)",
    "shouldertap://join?code=\(code)",
    "https://shouldertap.app/join#\(code.replacingOccurrences(of: ".", with: "%2E"))",
  ])
  func readsInviteCodes(input: String) {
    #expect(inviteCode(from: input) == code)
  }

  @Test(arguments: ["", "https://shouldertap.app/join", "a.b.c", "short.invite12.secret1234", "x.y"])
  func rejectsNonInvites(input: String) {
    #expect(inviteCode(from: input) == nil)
  }

  @Test func requestIdsFitTheContract() {
    let id = newRequestId()
    #expect(id.count == 32)
    #expect(id != newRequestId())
  }
}

@Suite(.serialized) @MainActor struct SenderBehavior {
  @Test func anAccountGrantBecomesAPairingWithoutRedeeming() throws {
    let persistence = MemorySenderPersistence()
    let calls = Calls()
    let store = makeStore(persistence) { request in _ = calls.record(request); return (503, "") }
    let session = try store.add(try JSONDecoder().decode(SenderGrant.self, from: Data(accountSender.utf8)))
    #expect(session.pairing.recipientName == "Jamie")
    #expect(session.pairing.senderName == "Rosa")
    #expect(session.color == .plum)
    #expect(persistence.loadPairings().map(\.token) == ["inbox123.s1s1s1s1.secret5678"])
    #expect(calls.count("/v1/invites/redeem") == 0)
  }

  @Test func deviceGrantsAreRejected() {
    let persistence = MemorySenderPersistence()
    let store = makeStore(persistence) { _ in (503, "") }
    let device = SenderGrant(
      id: "inbox123:d1", grant: CredentialGrant(kind: .device, credentialId: "d1", token: "inbox123.d1d1d1d1.secret5678", recipientName: "Jamie"),
      name: "Rosa", color: .moss)
    #expect(throws: APIError.self) { try store.add(device) }
    #expect(persistence.loadPairings().isEmpty)
  }

  @Test func aNewKeyForTheSameRecipientReplacesTheOldOne() throws {
    let persistence = MemorySenderPersistence(pairings: [pairing("old0old0")])
    let store = makeStore(persistence) { _ in (503, "") }
    store.start()
    #expect(store.sessions.map(\.id) == ["old0old0"])
    try store.add(try JSONDecoder().decode(SenderGrant.self, from: Data(accountSender.utf8)))
    #expect(store.sessions.map(\.id) == ["s1"])
    #expect(persistence.loadPairings().map(\.credentialId) == ["s1"])
  }

  @Test func droppingRemovedTokensForgetsOnlyThosePairings() {
    let kept = SenderPairing(
      token: "inbox999.k1k1k1k1.secret5678", credentialId: "k1k1k1k1", recipientName: "Ari", senderName: "Rosa",
      color: .sky, pairedAt: 2)
    let persistence = MemorySenderPersistence(pairings: [pairing(), kept])
    let store = makeStore(persistence) { _ in (503, "") }
    store.start()
    store.drop(tokens: ["inbox123.s1s1s1s1.secret5678", "someone.else12.secret5678"])
    #expect(store.sessions.map(\.id) == ["k1k1k1k1"])
    #expect(persistence.loadPairings().map(\.credentialId) == ["k1k1k1k1"])
  }

  @Test func sendsWithARequestIdAndMergesTheTap() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let store = makeStore(persistence) { request in
      guard request.url!.path == "/v1/taps" else { return (503, "") }
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer inbox123.s1s1s1s1.secret5678")
      let payload = body(request)
      #expect(payload["requestId"]?.count == 32)
      return (201, sentTap(payload["body"] ?? ""))
    }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("  Dinner's ready ")
    #expect(session.outbox.first?.body == "Dinner's ready")
    #expect(await eventually { session.outbox.isEmpty })
    #expect(session.taps.first?.body == "Dinner's ready")
    #expect(persistence.loadOutbox(credentialId: "s1s1s1s1").isEmpty)
  }

  @Test func aPatronsTapCarriesTheThemeAndKey() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let store = makeStore(persistence) { request in
      guard request.url!.path == "/v1/taps" else { return (503, "") }
      let payload = body(request)
      #expect(payload["theme"] == "broadsheet")
      #expect(payload["patronKey"] == "stp1.patron01.key00001.secret")
      return (201, sentTap(payload["body"] ?? ""))
    }
    store.style = { SendStyle(theme: .broadsheet, patronKey: "stp1.patron01.key00001.secret") }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("Dinner's ready")
    #expect(session.outbox.first?.theme == .broadsheet)
    #expect(await eventually { session.taps.first?.body == "Dinner's ready" })
  }

  @Test func withoutAKeyATapGoesInDefault() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let store = makeStore(persistence) { request in
      guard request.url!.path == "/v1/taps" else { return (503, "") }
      let payload = body(request)
      #expect(payload["theme"] == nil)
      #expect(payload["patronKey"] == nil)
      return (201, sentTap(payload["body"] ?? ""))
    }
    store.style = { SendStyle(theme: .note, patronKey: nil) }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("Call me")
    #expect(await eventually { session.taps.first?.body == "Call me" })
  }

  @Test func aTapCarriesTheSendersOwnReplies() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let sent = Collected<[[String]]>()
    let store = makeStore(persistence) { request in
      guard request.url!.path == "/v1/taps" else { return (503, "") }
      let payload = try! JSONSerialization.jsonObject(with: rawBody(request)) as! [String: Any]
      sent.append((payload["replies"] as? [String]) ?? [])
      return (201, sentTap(payload["body"] as? String ?? ""))
    }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("Dinner's ready", replies: [" Coming! ", "Can't now"])
    #expect(session.outbox.first?.replies == ["Coming!", "Can't now"])
    #expect(await eventually { sent.value.count == 1 })
    #expect(sent.value == [["Coming!", "Can't now"]])
    #expect(throws: SendError.replies(.same)) { try session.send("Again", replies: ["Yes", "yes"]) }
  }

  @Test func onItAndInTenMinutesAreSentAsTheDefaults() throws {
    #expect(try normalizeQuickReplies(["On it", " In 10 min"]).get() == nil)
    #expect(throws: QuickRepliesError.missing) { try normalizeQuickReplies(["Yes", ""]).get() }
    #expect(throws: QuickRepliesError.tooLong) {
      try normalizeQuickReplies(["Yes", "Give me twenty-five minutes"]).get()
    }
  }

  @Test func outboxesSavedBeforeThemesStillDecode() throws {
    let saved = #"{"requestId":"r1","body":"Hi","createdAt":1,"failed":false}"#
    let item = try JSONDecoder().decode(OutgoingTap.self, from: Data(saved.utf8))
    #expect(item.theme == nil)
    #expect(item.body == "Hi")
  }

  @Test func rejectsEmptyAndOverlongDrafts() throws {
    let store = makeStore(MemorySenderPersistence(pairings: [pairing()])) { _ in (503, "") }
    store.start()
    let session = try #require(store.sessions.first)
    #expect(throws: SendError.empty) { try session.send("   ") }
    #expect(throws: SendError.tooLong) { try session.send(String(repeating: "a", count: maxTapLength + 1)) }
    #expect(session.outbox.isEmpty)
  }

  @Test func offlineSendsKeepTheirRequestIdUntilAccepted() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let calls = Calls()
    let ids = Collected<[String]>()
    let store = makeStore(persistence) { request in
      switch request.url!.path {
      case "/v1/taps":
        let payload = body(request)
        ids.append(payload["requestId"] ?? "")
        return calls.record(request) < 2 ? (503, "") : (201, sentTap(payload["body"] ?? ""))
      case "/v1/me":
        return (200, String(decoding: try! fixture("sender_snapshot"), as: UTF8.self))
      default:
        return (503, "")
      }
    }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("Hi")
    #expect(await eventually { calls.count("/v1/taps") == 1 })
    try? await Task.sleep(for: .milliseconds(50))
    #expect(session.outbox.first?.failed == false)
    #expect(persistence.loadOutbox(credentialId: "s1s1s1s1").count == 1)

    session.resync()
    #expect(await eventually { session.outbox.isEmpty })
    #expect(Set(ids.value).count == 1)
    #expect(session.taps.contains { $0.id == "t9" })
    #expect(session.taps.contains { $0.id == "t2" })
  }

  @Test func rejectedSendsAreMarkedFailedThenRetried() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let calls = Calls()
    let store = makeStore(persistence) { request in
      guard request.url!.path == "/v1/taps" else { return (503, "") }
      return calls.record(request) == 1
        ? (400, #"{"_tag":"InvalidRequest","message":"Nope"}"#) : (201, sentTap("Hi"))
    }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("Hi")
    #expect(await eventually { session.outbox.first?.failed == true })
    session.retry(requestId: try #require(session.outbox.first?.requestId))
    #expect(await eventually { session.outbox.isEmpty })
  }

  @Test func pausedTrialFailsWithTheMessageAndIsNotRetried() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let calls = Calls()
    let paused = "Jamie's Shouldertap trial has ended, so taps are paused."
    let store = makeStore(persistence) { request in
      switch request.url!.path {
      case "/v1/taps":
        _ = calls.record(request)
        return (402, #"{"_tag":"PaymentRequired","message":"\#(paused)"}"#)
      case "/v1/me":
        return (200, String(decoding: try! fixture("sender_snapshot"), as: UTF8.self))
      default:
        return (503, "")
      }
    }
    store.start()
    let session = try #require(store.sessions.first)
    try session.send("Hi")
    #expect(await eventually { session.outbox.first?.failed == true })
    #expect(session.outbox.first?.error == paused)
    // A resync pushes queued sends again, but not refused ones.
    session.resync()
    #expect(await eventually { session.loaded })
    try? await Task.sleep(for: .milliseconds(50))
    #expect(calls.count("/v1/taps") == 1)
  }

  @Test func snapshotFillsAMissingColor() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing(color: nil)])
    let store = makeStore(persistence) { request in
      request.url!.path == "/v1/me"
        ? (200, String(decoding: try! fixture("sender_snapshot"), as: UTF8.self)) : (503, "")
    }
    store.start()
    let session = try #require(store.sessions.first)
    session.resync()
    #expect(await eventually { session.loaded })
    #expect(session.color == .rose)
    #expect(persistence.loadPairings().first?.color == .rose)
  }

  @Test func unpairRevokesTheCredential() async {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let deletes = Collected<[String]>()
    let store = makeStore(persistence) { request in
      if request.httpMethod == "DELETE" {
        deletes.append(request.url!.path)
        return (200, #"{"revoked":true}"#)
      }
      return (503, "")
    }
    store.start()
    store.unpair(id: "s1s1s1s1")
    #expect(store.sessions.isEmpty)
    #expect(persistence.loadPairings().isEmpty)
    #expect(await eventually { deletes.value == ["/v1/credentials/s1s1s1s1"] })
    #expect(store.notice == nil)
  }

  @Test func deletingDataWaitsForServerConfirmation() async throws {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let deletes = Collected<[String]>()
    let store = makeStore(persistence) { request in
      if request.httpMethod == "DELETE" {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer inbox123.s1s1s1s1.secret5678")
        deletes.append(request.url!.path)
        return (200, #"{"deleted":true}"#)
      }
      return (503, "")
    }
    store.start()
    try await store.deleteData(id: "s1s1s1s1")
    #expect(deletes.value == ["/v1/sender"])
    #expect(store.sessions.isEmpty)
    #expect(persistence.loadPairings().isEmpty)
  }

  @Test func failedDeletionPreservesThePairingForRetry() async {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let store = makeStore(persistence) { _ in (503, "") }
    store.start()
    do { try await store.deleteData(id: "s1s1s1s1"); Issue.record("Expected deletion to fail") }
    catch { }
    #expect(store.sessions.count == 1)
    #expect(persistence.loadPairings().count == 1)
  }

  @Test func revokedPairingsAreForgotten() async {
    let persistence = MemorySenderPersistence(pairings: [pairing()])
    let store = makeStore(persistence) { request in
      request.url!.path == "/v1/connect-tickets" ? (401, #"{"_tag":"Unauthorized","message":"Revoked"}"#) : (503, "")
    }
    store.start()
    #expect(await eventually { store.sessions.isEmpty })
    #expect(persistence.loadPairings().isEmpty)
    #expect(store.notice == "Jamie removed this pairing")
  }
}

/// A tiny lock-protected box for collecting values from stub handlers.
final class Collected<Value: Sendable>: @unchecked Sendable where Value: RangeReplaceableCollection {
  private let lock = NSLock()
  private var stored = Value()
  var value: Value { lock.withLock { stored } }
  func append(_ element: Value.Element) { lock.withLock { stored.append(element) } }
}
