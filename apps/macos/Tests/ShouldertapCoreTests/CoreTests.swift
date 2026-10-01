import Foundation
import Testing

@testable import ShouldertapCore

private func tap(_ id: String, createdAt: Double, sequence: Int, state: Tap.State = .pending) -> Tap {
  Tap(
    id: id, senderId: "s1", senderName: "Sam", senderColor: .cobalt, body: "Hi", createdAt: createdAt,
    state: state, displayedAt: nil, acknowledgedAt: nil, acknowledgedBy: nil, response: nil,
    sequence: sequence)
}

private func fixture(_ name: String) throws -> Data {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try Data(contentsOf: url)
}

@Suite struct Merging {
  @Test func newestFirst() {
    let merged = mergeTap([tap("a", createdAt: 1, sequence: 1)], tap("b", createdAt: 2, sequence: 1))
    #expect(merged.map(\.id) == ["b", "a"])
  }

  @Test func olderCopyIsIgnored() {
    let current = [tap("a", createdAt: 1, sequence: 5, state: .acknowledged)]
    #expect(mergeTap(current, tap("a", createdAt: 1, sequence: 3)).first?.state == .acknowledged)
  }

  @Test func newerCopyReplaces() {
    let current = [tap("a", createdAt: 1, sequence: 3)]
    let merged = mergeTap(current, tap("a", createdAt: 1, sequence: 4, state: .acknowledged))
    #expect(merged.count == 1)
    #expect(merged.first?.state == .acknowledged)
  }

  @Test func snapshotKeepsNewerLocalCopies() {
    let local = [tap("a", createdAt: 1, sequence: 9, state: .acknowledged)]
    let snapshot = [tap("a", createdAt: 1, sequence: 2), tap("b", createdAt: 2, sequence: 1)]
    let merged = mergeSnapshot(local: local, snapshot: snapshot)
    #expect(merged.map(\.id) == ["b", "a"])
    #expect(merged.last?.sequence == 9)
  }

  @Test func snapshotDropsTapsTheServerForgot() {
    let merged = mergeSnapshot(local: [tap("old", createdAt: 1, sequence: 1)], snapshot: [])
    #expect(merged.isEmpty)
  }
}

@Suite struct Contracts {
  @Test func decodesReceiverSnapshot() throws {
    guard case let .receiver(snapshot) = try JSONDecoder().decode(Snapshot.self, from: fixture("snapshot"))
    else { Issue.record("expected a receiver snapshot"); return }
    #expect(snapshot.recipientName == "Jamie")
    #expect(snapshot.taps.first?.response == TapResponse(kind: .text, text: "Coming"))
    #expect(snapshot.credentials.contains { $0.kind == .sender && $0.color == .rose })
    #expect(snapshot.credentials.contains { $0.kind == .device && $0.color == nil })
  }

  @Test func decodesEvents() throws {
    let events = try JSONDecoder().decode([ServerEvent].self, from: fixture("events"))
    guard case let .tap(first) = events[0] else { Issue.record("expected a tap"); return }
    #expect(first.body == "Dinner's ready")
    guard case .credentialsChanged = events[1], case .revoked = events[2], case .unknown = events[3] else {
      Issue.record("unexpected events \(events)")
      return
    }
  }

  @Test func unknownColorFallsBack() throws {
    let json = #"{"id":"c","kind":"sender","name":"N","color":"chartreuse","createdAt":1,"lastSeenAt":null}"#
    #expect(try JSONDecoder().decode(Credential.self, from: Data(json.utf8)).color == .cobalt)
  }

  @Test func responseOmitsMissingText() throws {
    let json = String(decoding: try JSONEncoder().encode(TapResponse.onIt), as: UTF8.self)
    #expect(json == #"{"kind":"on_it"}"#)
  }

  /// Same answers as `fallbackColor` in packages/domain/src/colors.ts.
  @Test(arguments: [("s1", PersonColor.sky), ("abcDEF123", .ochre), ("cred_9f8e7d", .sky), ("x", .moss)])
  func fallbackColorMatchesWeb(id: String, color: PersonColor) {
    #expect(PersonColor.fallback(for: id) == color)
  }

  @Test func responseLabels() {
    #expect(TapResponse.onIt.label == "On it")
    #expect(TapResponse(kind: .text, text: "  ").label == "Replied")
  }
}

@Suite struct Client {
  @Test func socketURL() {
    let api = APIClient(baseURL: URL(string: "https://api.shouldertap.app")!)
    #expect(api.socketURL(ticket: "a.b.c")?.absoluteString == "wss://api.shouldertap.app/v1/connect?ticket=a.b.c")
    let local = APIClient(baseURL: URL(string: "http://localhost:3000")!)
    #expect(local.socketURL(ticket: "t")?.absoluteString == "ws://localhost:3000/v1/connect?ticket=t")
  }

  @Test func errorsMapByStatus() {
    let body = Data(#"{"_tag":"NotFound","message":"No such tap"}"#.utf8)
    let error = APIError.from(status: 404, body: body)
    #expect(error.code == .notFound)
    #expect(error.message == "No such tap")
    #expect(!error.isRetryable)
    #expect(APIError.from(status: 503, body: Data()).isRetryable)
  }
}

@Suite struct Persistence {
  @Test func roundTrips() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let suite = "test.\(UUID().uuidString)"
    let store = LocalPersistence(directory: directory, defaultsSuite: suite)
    defer {
      try? FileManager.default.removeItem(at: directory)
      UserDefaults().removePersistentDomain(forName: suite)
    }
    #expect(store.loadCredential() == nil)
    try store.saveCredential("inbox.id.secret")
    #expect(store.loadCredential() == "inbox.id.secret")
    let attributes = try FileManager.default.attributesOfItem(
      atPath: directory.appending(path: "credential.secret").path)
    #expect((attributes[.posixPermissions] as? Int) == 0o600)
    store.deleteCredential()
    #expect(store.loadCredential() == nil)

    store.savePendingAcks(["t1": .in10])
    #expect(store.loadPendingAcks() == ["t1": .in10])
    store.savePendingAcks([:])
    #expect(store.loadPendingAcks().isEmpty)
  }
}
