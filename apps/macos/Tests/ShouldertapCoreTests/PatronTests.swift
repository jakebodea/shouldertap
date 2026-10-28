import Foundation
import Testing

@testable import ShouldertapCore

private let api = URL(string: "https://api.test")!

@Suite struct PatronNudgeRule {
  @Test(arguments: [
    (4, 0, false, true, false),
    (5, 0, false, true, true),
    (19, 1, false, true, false),
    (20, 1, false, true, true),
    (50, 2, false, true, true),
    (999, 3, false, true, false),
    (5, 0, true, true, false),
    (5, 0, false, false, false),
  ])
  func mentionsMembershipAtTheMilestones(_ input: (Int, Int, Bool, Bool, Bool)) {
    let (sent, shown, patron, checkoutEnabled, expected) = input
    #expect(PatronNudge.due(sent: sent, shown: shown, patron: patron, checkoutEnabled: checkoutEnabled) == expected)
  }
}

@Suite(.serialized) @MainActor struct PatronMembership {
  private func defaults() -> UserDefaults {
    let name = "patron-tests-\(UUID().uuidString)"
    return UserDefaults(suiteName: name)!
  }

  @Test func anActiveMembershipGetsAKeyForThisDeviceAndThemesItsTaps() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let session = StubProtocol.session { request in
      switch request.url!.path {
      case "/account/patron/status":
        return (
          200,
          #"{"memberships":[{"id":"patron01","name":"Membership","status":{"patron":{"active":true,"status":"active","paidUntil":1824135813255,"canManage":true,"canSubscribe":false}}}],"checkoutEnabled":true}"#
        )
      case "/account/restore": return (200, #"{"key":"stp1.patron01.key00002.secret"}"#)
      default: return (404, "{}")
      }
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patronVault = MemoryVault()
    let patron = PatronStore(account: account, vault: patronVault, defaults: defaults())
    patron.theme = .terminal
    #expect(patron.style == SendStyle())
    await patron.refresh()
    #expect(patron.active)
    #expect(patronVault.read() == "stp1.patron01.key00002.secret")
    #expect(patron.style == SendStyle(theme: .terminal, patronKey: "stp1.patron01.key00002.secret"))
  }

  @Test func aHeldKeyThemesTapsUntilStatusSaysTheMembershipEnded() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let session = StubProtocol.session { request in
      request.url!.path == "/account/patron/status"
        ? (200, #"{"memberships":[],"checkoutEnabled":true}"#) : (404, "{}")
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patronVault = MemoryVault()
    try patronVault.write("stp1.patron01.key00002.secret")
    let patron = PatronStore(account: account, vault: patronVault, defaults: defaults())
    patron.theme = .note
    let atLaunch = patron.style
    await patron.refresh()
    #expect([atLaunch, patron.style] == [SendStyle(theme: .note, patronKey: "stp1.patron01.key00002.secret"), SendStyle()])
  }

  @Test func signingOutForgetsThisDevicesPatronKeyAndRevokesIt() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let revoked = Arrivals()
    let session = StubProtocol.session { request in
      switch (request.httpMethod, request.url!.path) {
      case ("POST", "/api/auth/sign-out"): return (200, #"{"success":true}"#)
      case ("DELETE", "/v1/patrons/me/key"):
        revoked.record(request.value(forHTTPHeaderField: "Authorization"))
        return (200, #"{"forgotten":true}"#)
      default: return (404, "{}")
      }
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patronVault = MemoryVault()
    try patronVault.write("stp1.patron01.key00002.secret")
    let patron = PatronStore(account: account, vault: patronVault, defaults: defaults())
    patron.theme = .note
    await account.signOut()
    #expect(patronVault.read() == nil)
    #expect(patron.style == SendStyle())
    #expect(await revoked.next() == "Bearer stp1.patron01.key00002.secret")
  }

  @Test func signingOutWhileAKeyIsBeingMintedForgetsIt() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let minting = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let revoked = Arrivals()
    let session = StubProtocol.session { request in
      switch request.url!.path {
      case "/account/patron/status":
        return (
          200,
          #"{"memberships":[{"id":"patron01","name":"Membership","status":{"patron":{"active":true,"status":"active","paidUntil":1824135813255,"canManage":true,"canSubscribe":false}}}],"checkoutEnabled":true}"#
        )
      case "/account/restore":
        // The server's answer arrives only after the sign-out below.
        minting.signal()
        release.wait()
        return (200, #"{"key":"stp1.patron01.key00002.secret"}"#)
      case "/api/auth/sign-out": return (200, #"{"success":true}"#)
      case "/v1/patrons/me/key":
        revoked.record(request.value(forHTTPHeaderField: "Authorization"))
        return (200, #"{"forgotten":true}"#)
      default: return (404, "{}")
      }
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patronVault = MemoryVault()
    let patron = PatronStore(account: account, vault: patronVault, defaults: defaults())
    patron.theme = .terminal
    let refreshing = Task { await patron.refresh() }
    await withCheckedContinuation { done in
      DispatchQueue.global().async {
        minting.wait()
        done.resume()
      }
    }
    await account.signOut()
    release.signal()
    await refreshing.value
    #expect(patronVault.read() == nil)
    #expect(patron.style == SendStyle())
    // The key minted for the account that signed out doesn't stay live.
    #expect(await revoked.next() == "Bearer stp1.patron01.key00002.secret")
  }

  @Test func aRefreshAskedForMidRefreshReadsStatusAgain() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let reading = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let reads = Arrivals()
    let session = StubProtocol.session { request in
      guard request.url!.path == "/account/patron/status" else { return (404, "{}") }
      reads.record(request.url!.path)
      reading.signal()
      release.wait()
      return (200, #"{"memberships":[],"checkoutEnabled":true}"#)
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patron = PatronStore(account: account, vault: MemoryVault(), defaults: defaults())
    let first = Task { await patron.refresh() }
    await withCheckedContinuation { done in
      DispatchQueue.global().async {
        reading.wait()
        done.resume()
      }
    }
    // Asked for while the first is still reading (a sign-in, say).
    let second = Task { await patron.refresh() }
    await Task.yield()
    release.signal()
    release.signal()
    await first.value
    await second.value
    #expect(await [reads.next(), reads.next()] == ["/account/patron/status", "/account/patron/status"])
  }

  @Test func withoutAMembershipTapsStayDefaultAndTheNudgeComesAfterFiveSends() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let session = StubProtocol.session { request in
      request.url!.path == "/account/patron/status"
        ? (200, #"{"memberships":[],"checkoutEnabled":true}"#) : (404, "{}")
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patron = PatronStore(account: account, vault: MemoryVault(), defaults: defaults())
    patron.theme = .note
    await patron.refresh()
    #expect(patron.style == SendStyle())
    for _ in 0..<4 { patron.recordSend() }
    #expect(!patron.nudgeDue)
    patron.recordSend()
    #expect(patron.nudgeDue)
    patron.nudgeHandled()
    #expect(!patron.nudgeDue)
  }
}

/// What reached the server (revoked keys, status reads), in order.
private final class Arrivals: @unchecked Sendable {
  private let lock = NSLock()
  private let arrived = DispatchSemaphore(value: 0)
  private var keys: [String?] = []

  func record(_ authorization: String?) {
    lock.withLock { keys.append(authorization) }
    arrived.signal()
  }

  /// The next revocation, waiting up to two seconds for it.
  func next() async -> String?? {
    await withCheckedContinuation { done in
      DispatchQueue.global().async {
        guard self.arrived.wait(timeout: .now() + 2) == .success else { return done.resume(returning: nil) }
        done.resume(returning: self.lock.withLock { self.keys.removeFirst() })
      }
    }
  }
}
