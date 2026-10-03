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
    // A device without a platform (older server) is a Mac.
    #expect(snapshot.credentials.first { $0.id == "dev1" }?.devicePlatform == .mac)
    #expect(snapshot.credentials.first { $0.id == "dev2" }?.devicePlatform == .iphone)
    #expect(snapshot.plan == Plan(status: .trial, trialEndsAt: 1_791_990_000_000))
  }

  /// Servers older than payments send no plan; neither does a malformed one.
  @Test(arguments: ["", #","plan":{"status":"lifetime","trialEndsAt":1}"#])
  func receiverSnapshotToleratesMissingPlan(plan: String) throws {
    let json = #"{"kind":"device","credentialId":"d","recipientName":"J","sequence":0,"taps":[],"credentials":[]"#
    guard case let .receiver(snapshot) = try JSONDecoder().decode(Snapshot.self, from: Data((json + plan + "}").utf8))
    else { Issue.record("expected a receiver snapshot"); return }
    #expect(snapshot.plan == nil)
  }

  @Test func planDaysLeftAndExpiry() {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let ms = now.timeIntervalSince1970 * 1000
    let day = 86_400_000.0
    let trial = { (ends: Double) in Plan(status: .trial, trialEndsAt: ends) }
    #expect(trial(ms + 14 * day).daysLeft(now: now) == 14)
    #expect(trial(ms + 2.5 * day).daysLeft(now: now) == 3)
    #expect(trial(ms + 1000).daysLeft(now: now) == 1)
    #expect(trial(ms + 1000).currentStatus(now: now) == .trial)
    // Ran out since the last snapshot: already expired.
    #expect(trial(ms - 1).daysLeft(now: now) == 0)
    #expect(trial(ms - 1).currentStatus(now: now) == .expired)
    #expect(Plan(status: .paid, trialEndsAt: ms - day).currentStatus(now: now) == .paid)
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

  /// Windows PCs pair as computers; a platform newer than this app reads as a Mac.
  @Test func decodesDevicePlatforms() throws {
    let device = { (platform: String) in
      #"{"id":"d","kind":"device","name":"N","color":null,"platform":"\#(platform)","createdAt":1,"lastSeenAt":null}"#
    }
    let windows = try JSONDecoder().decode(Credential.self, from: Data(device("windows").utf8))
    #expect(windows.devicePlatform == .windows)
    #expect(windows.devicePlatform.showsTaps)
    #expect(try JSONDecoder().decode(Credential.self, from: Data(device("vision").utf8)).devicePlatform == .mac)
    #expect(!DevicePlatform.iphone.showsTaps)
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
    #expect(APIError.from(status: 503, body: Data()).code == .network)
  }

  @Test func paymentErrorsKeepTheServersMessage() {
    let paused = APIError.from(
      status: 402, body: Data(#"{"_tag":"PaymentRequired","message":"Taps are paused."}"#.utf8))
    #expect(paused.code == .paymentRequired)
    #expect(!paused.isRetryable)
    #expect(paused.localizedDescription == "Taps are paused.")
    let unavailable = APIError.from(
      status: 503, body: Data(#"{"_tag":"Unavailable","message":"Payments aren't set up here yet."}"#.utf8))
    #expect(unavailable.code == .unavailable)
    #expect(unavailable.localizedDescription == "Payments aren't set up here yet.")
  }
}

@Suite struct TrialFingerprint {
  private let uuid = "00000000-0000-0000-0000-000000000001"

  @Test func isASaltedSHA256InLowercaseHex() {
    // printf '%s' "shouldertap-trial-v1:<uuid>" | shasum -a 256
    #expect(
      MachineFingerprint.make(hardwareUUID: uuid, salt: MachineFingerprint.releaseSalt)
        == "83b90d91bc723de2adebfb2d1dded3800d545d2035b796293f916e0cf83c8924")
  }

  @Test func debugBuildsGetTheirOwnFingerprint() {
    #expect(
      MachineFingerprint.make(hardwareUUID: uuid, salt: MachineFingerprint.debugSalt)
        == "e3d40e566b8ccefa7ef227c07c3e5b9940ea072a8c1e6e0fb5db0731c371107e")
  }

  @Test func neverContainsTheHardwareID() throws {
    let fingerprint = try #require(MachineFingerprint.make(hardwareUUID: uuid, salt: MachineFingerprint.releaseSalt))
    #expect(fingerprint.wholeMatch(of: /[0-9a-f]{64}/) != nil)
    #expect(!fingerprint.contains(uuid))
  }

  @Test func emptyHardwareIDSendsNothing() {
    #expect(MachineFingerprint.make(hardwareUUID: "", salt: MachineFingerprint.releaseSalt) == nil)
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

  @Test func movesAFileCredentialIntoTheVault() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "credential.secret")
    // An older, ad-hoc build left its credential in the file.
    try LocalPersistence(directory: directory).saveCredential("inbox.id.secret")

    let vault = MemoryVault()
    let store = LocalPersistence(directory: directory, vault: vault)
    #expect(store.loadCredential() == "inbox.id.secret")
    #expect(vault.read() == "inbox.id.secret")
    #expect(!FileManager.default.fileExists(atPath: file.path))

    try store.saveCredential("inbox.id.other")
    #expect(vault.read() == "inbox.id.other")
    #expect(!FileManager.default.fileExists(atPath: file.path))
    store.deleteCredential()
    #expect(store.loadCredential() == nil)
  }

  @Test func keepsTheFileWhenTheVaultFails() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try LocalPersistence(directory: directory).saveCredential("inbox.id.secret")

    let store = LocalPersistence(directory: directory, vault: MemoryVault(failing: true))
    #expect(store.loadCredential() == "inbox.id.secret")
    // Still readable next launch: the file stays until a write succeeds.
    #expect(LocalPersistence(directory: directory).loadCredential() == "inbox.id.secret")
  }
}

final class MemoryVault: CredentialVault, @unchecked Sendable {
  private var token: String?
  private let failing: Bool

  init(failing: Bool = false) { self.failing = failing }

  func read() -> String? { token }
  func write(_ token: String) throws {
    if failing { throw CocoaError(.fileWriteUnknown) }
    self.token = token
  }
  func delete() { token = nil }
}
