import Foundation
import Testing

@testable import ShouldertapCore

@Suite struct VerificationTests {
  @Test func runsKeepReceiverCredentialsAndPendingRepliesSeparate() throws {
    let first = try VerificationScope(runID: "one-\(UUID().uuidString)")
    let second = try VerificationScope(runID: "two-\(UUID().uuidString)")
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let firstSuite = first.namespace("shouldertap-tests")
    let secondSuite = second.namespace("shouldertap-tests")
    defer {
      try? FileManager.default.removeItem(at: root)
      UserDefaults.standard.removePersistentDomain(forName: firstSuite)
      UserDefaults.standard.removePersistentDomain(forName: secondSuite)
    }
    let a = LocalPersistence(directory: first.directory(in: root), defaultsSuite: firstSuite)
    let b = LocalPersistence(directory: second.directory(in: root), defaultsSuite: secondSuite)
    try a.saveCredential("first-receiver")
    try b.saveCredential("second-receiver")
    a.savePendingAcks(["tap": .onIt])
    b.savePendingAcks(["tap": .in10])
    #expect(a.loadCredential() == "first-receiver")
    #expect(b.loadCredential() == "second-receiver")
    #expect(a.loadPendingAcks()["tap"] == .onIt)
    #expect(b.loadPendingAcks()["tap"] == .in10)
    a.deleteCredential()
    #expect(b.loadCredential() == "second-receiver")
    #expect(b.loadPendingAcks()["tap"] == .in10)
  }

  @Test(arguments: ["", "../other", "a/b", "a\\b", "two runs", ".", "å"])
  func rejectsUnsafeRunIdentifiers(_ runID: String) {
    #expect(throws: VerificationScope.InvalidRun.self) { try VerificationScope(runID: runID) }
  }
}
