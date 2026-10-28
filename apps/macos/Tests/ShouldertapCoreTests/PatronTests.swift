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

  @Test func signingOutForgetsThisDevicesPatronKey() async throws {
    let accountVault = MemoryVault()
    try accountVault.write("account-session")
    let session = StubProtocol.session { request in
      request.url!.path == "/api/auth/sign-out" ? (200, #"{"success":true}"#) : (404, "{}")
    }
    let account = AccountStore(server: api, vault: accountVault, session: session)
    let patronVault = MemoryVault()
    try patronVault.write("stp1.patron01.key00002.secret")
    let patron = PatronStore(account: account, vault: patronVault, defaults: defaults())
    patron.theme = .note
    await account.signOut()
    #expect(patronVault.read() == nil)
    #expect(patron.style == SendStyle())
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
