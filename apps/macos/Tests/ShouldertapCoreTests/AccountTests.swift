import Foundation
import Testing
@testable import ShouldertapCore

private let api = URL(string: "https://api.test")!
private let jakeMe = #"{"email":"jake@example.com","profile":{"name":"Jake","color":"moss"},"suggestedName":null,"inboxId":"inboxAAA"}"#
private let newMe = #"{"email":"jake@example.com","profile":null,"suggestedName":"Jake B","inboxId":null}"#

/// The request's JSON body, read back the way the server would.
private func json(_ request: URLRequest) -> NSDictionary {
  var data = request.httpBody ?? Data()
  if data.isEmpty, let stream = request.httpBodyStream {
    stream.open()
    defer { stream.close() }
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      data.append(buffer, count: count)
    }
  }
  return (try? JSONSerialization.jsonObject(with: data)) as? NSDictionary ?? [:]
}

/// Every request the fake server saw, as "METHOD /path auth body".
private final class Log: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []
  func record(_ request: URLRequest) {
    let auth = request.value(forHTTPHeaderField: "Authorization") ?? "-"
    let query = request.url?.query.map { "?\($0)" } ?? ""
    lock.withLock { lines.append("\(request.httpMethod ?? "") \(request.url!.path)\(query) \(auth)") }
  }
  var value: [String] { lock.withLock { lines } }
}

private final class Bodies: @unchecked Sendable {
  private let lock = NSLock()
  private var bodies: [String: NSDictionary] = [:]
  func record(_ request: URLRequest) { lock.withLock { bodies[request.url!.path] = json(request) } }
  subscript(path: String) -> NSDictionary? { lock.withLock { bodies[path] } }
}

@MainActor
private func signedIn(_ handler: @escaping StubProtocol.Handler) async throws -> AccountStore {
  let vault = MemoryVault()
  try vault.write("account-session")
  let account = AccountStore(server: api, vault: vault, session: StubProtocol.session(handler))
  await account.refresh()
  return account
}

@Suite(.serialized) @MainActor struct AccountSignIn {
  @Test func sendingACodeUsesTheEmailAndNoSession() async {
    let log = Log()
    let bodies = Bodies()
    let account = AccountStore(server: api, vault: MemoryVault(), session: StubProtocol.session { request in
      log.record(request); bodies.record(request)
      return (200, #"{"success":true}"#)
    })
    #expect(await account.sendCode(email: "  jake@example.com "))
    #expect(account.pendingEmail == "jake@example.com")
    #expect(log.value == ["POST /api/auth/email-otp/send-verification-otp -"])
    #expect(bodies["/api/auth/email-otp/send-verification-otp"] == ["email": "jake@example.com", "type": "sign-in"])
  }

  @Test func aMistypedEmailIsCaughtBeforeSending() async {
    let log = Log()
    let account = AccountStore(server: api, vault: MemoryVault(), session: StubProtocol.session { request in
      log.record(request); return (200, #"{"success":true}"#)
    })
    #expect(await account.sendCode(email: "jake.example.com") == false)
    #expect(account.error == "Enter your email address.")
    #expect(log.value.count == 0)
  }

  @Test func theCodeSignsInAndKeepsTheSessionInTheVault() async {
    let vault = MemoryVault()
    let log = Log()
    let bodies = Bodies()
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { request in
      log.record(request); bodies.record(request)
      switch request.url!.path {
      case "/api/auth/sign-in/email-otp": return (200, #"{"token":"session-123","user":{"email":"jake@example.com","id":"u1"}}"#)
      case "/account/me": return (200, newMe)
      default: return (200, #"{"success":true}"#)
      }
    })
    await account.sendCode(email: "jake@example.com")
    #expect(await account.verify(code: "123 456"))
    #expect(vault.read() == "session-123")
    #expect(account.signedIn)
    #expect(account.pendingEmail == nil)
    #expect(account.me?.suggestedName == "Jake B")
    #expect(account.me?.profile == nil)
    #expect(bodies["/api/auth/sign-in/email-otp"] == ["email": "jake@example.com", "otp": "123456"])
    #expect(log.value == [
      "POST /api/auth/email-otp/send-verification-otp -",
      "POST /api/auth/sign-in/email-otp -",
      "GET /account/me Bearer session-123",
    ])
  }

  @Test func aWrongCodeSaysWhatToDo() async {
    let vault = MemoryVault()
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { request in
      request.url!.path == "/api/auth/sign-in/email-otp"
        ? (400, #"{"error":"Invalid OTP"}"#) : (200, #"{"success":true}"#)
    })
    await account.sendCode(email: "jake@example.com")
    #expect(await account.verify(code: "000000") == false)
    #expect(account.error == "That code didn’t work. Check it or send a new one.")
    #expect(account.pendingEmail == "jake@example.com")
    #expect(vault.read() == nil)
  }

  @Test func changingTheEmailGoesBackAStep() async {
    let account = AccountStore(server: api, vault: MemoryVault(), session: StubProtocol.session { _ in
      (200, #"{"success":true}"#)
    })
    await account.sendCode(email: "jak@example.com")
    account.changeEmail()
    #expect(account.pendingEmail == nil)
    await account.sendCode(email: "jake@example.com")
    #expect(account.pendingEmail == "jake@example.com")
  }

  @Test func expiredAccountSessionAsksToSignInAgain() async throws {
    let vault = MemoryVault()
    try vault.write("old-session")
    let account = AccountStore(server: api, vault: vault,
      session: StubProtocol.session { _ in (401, #"{"error":"Sign in to continue"}"#) })
    await account.refresh()
    #expect(account.error == "Your sign-in expired. Sign in again.")
    #expect(vault.read() == nil)
    #expect(!account.signedIn)
  }

  @Test func deletingTheAccountForgetsTheSession() async throws {
    let vault = MemoryVault()
    try vault.write("account-session")
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { request in
      request.url?.path == "/api/auth/delete-user" && request.value(forHTTPHeaderField: "Authorization") == "Bearer account-session"
        ? (200, #"{"success":true,"message":"User deleted"}"#) : (403, #"{"error":"Forbidden"}"#)
    })
    await account.deleteAccount()
    #expect(vault.read() == nil)
    #expect(!account.signedIn)
  }

  @Test func serverWordingIsTranslatedForPeople() {
    #expect(accountMessage("Origin required") == "That didn’t work. Try again.")
    #expect(accountMessage("network") == "Couldn’t reach Shouldertap. Check your connection and try again.")
    #expect(accountMessage("Membership does not belong to this account", status: 401) == "Your sign-in expired. Sign in again.")
    #expect(accountMessage("That's your own invite", status: 400) == "That's your own invite")
  }
}

@Suite(.serialized) @MainActor struct AccountProfileAndSync {
  @Test func theYouStepSavesNameAndColor() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/profile" ? (200, jakeMe) : (200, newMe)
    }
    #expect(account.me?.profile == nil)
    #expect(await account.saveProfile(name: " Jake ", color: .moss))
    #expect(bodies["/account/profile"] == ["name": "Jake", "color": "moss"])
    #expect(account.me?.profile == Profile(name: "Jake", color: .moss))
    #expect(account.me?.inboxId == "inboxAAA")
  }

  @Test func syncReceivesTheInboxKeepsNewSendersAndDropsRemovedOnes() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      switch request.url!.path {
      case "/account/me": return (200, jakeMe)
      case "/account/sync":
        return (200, #"""
          {"me":\#(jakeMe),
           "inbox":{"kind":"device","credentialId":"dev11111","token":"inboxAAA.dev11111.secret111","recipientName":"Jake"},
           "senders":[{"id":"inboxMOM:mom11111","grant":{"kind":"sender","credentialId":"mom11111","token":"inboxMOM.key11111.secret222","recipientName":"Mom"},"name":"Jake","color":"moss"}],
           "removed":["inboxOLD.old11111.secret333"]}
          """#)
      default: return (503, "{}")
      }
    }
    let receiver = ReceiverStore(
      endpoints: Endpoints(server: api, web: URL(string: "https://web.test")!), persistence: MemoryPersistence(),
      session: StubProtocol.session { _ in (503, "{}") })
    receiver.start()
    let senderPersistence = MemorySenderPersistence(pairings: [SenderPairing(
      token: "inboxOLD.old11111.secret333", credentialId: "old11111", recipientName: "Ex", senderName: "Jake",
      color: .moss, pairedAt: 1)])
    let senders = SenderStore(server: api, persistence: senderPersistence, session: StubProtocol.session { _ in (503, "{}") })
    senders.start()

    await account.sync(platform: .iphone, deviceName: "Jake’s iPhone", inbox: receiver, senders: senders)

    #expect(bodies["/account/sync"] == [
      "platform": "iphone", "deviceName": "Jake’s iPhone", "receive": true, "tokens": ["inboxOLD.old11111.secret333"],
    ])
    #expect(receiver.accountCredential == "inboxAAA.dev11111.secret111")
    #expect(receiver.phase == .ready)
    #expect(senders.sessions.map(\.pairing.recipientName) == ["Mom"])
    #expect(senderPersistence.loadPairings().map(\.token) == ["inboxMOM.key11111.secret222"])
    #expect(senders.sessions.first?.pairing.senderName == "Jake")
    #expect(senders.sessions.first?.color == .moss)
  }

  @Test func syncSendsEveryTokenTheDeviceHolds() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/sync"
        ? (200, #"{"me":\#(jakeMe),"inbox":null,"senders":[],"removed":[]}"#) : (200, jakeMe)
    }
    let receiver = ReceiverStore(
      endpoints: Endpoints(server: api, web: URL(string: "https://web.test")!),
      persistence: MemoryPersistence(credential: "inboxAAA.dev11111.secret111"),
      session: StubProtocol.session { _ in (503, "{}") })
    let senders = SenderStore(server: api, persistence: MemorySenderPersistence(pairings: [SenderPairing(
      token: "inboxMOM.key11111.secret222", credentialId: "mom11111", recipientName: "Mom", senderName: "Jake",
      color: .moss, pairedAt: 1)]), session: StubProtocol.session { _ in (503, "{}") })
    senders.start()
    await account.sync(platform: .mac, deviceName: "", inbox: receiver, senders: senders)
    #expect(bodies["/account/sync"] == [
      "platform": "mac", "deviceName": "Mac", "receive": true,
      "tokens": ["inboxAAA.dev11111.secret111", "inboxMOM.key11111.secret222"],
    ])
  }

  @Test func syncWaitsForAProfile() async throws {
    let log = Log()
    let account = try await signedIn { request in log.record(request); return (200, newMe) }
    let senders = SenderStore(server: api, persistence: MemorySenderPersistence(), session: StubProtocol.session { _ in (503, "{}") })
    await account.sync(platform: .iphone, deviceName: "iPhone", inbox: nil, senders: senders)
    #expect(log.value == ["GET /v1/patrons/availability -", "GET /account/me Bearer account-session"])
  }
}

@Suite(.serialized) @MainActor struct AccountInvites {
  @Test func previewingAnInviteNeedsNoSignIn() async throws {
    let log = Log()
    let account = try await signedIn { request in
      log.record(request)
      return request.url!.path == "/v1/invites/preview"
        ? (200, #"{"name":"Mom","color":"plum","expiresAt":1800000000000}"#) : (200, jakeMe)
    }
    let preview = try await account.previewInvite(code: "https://shouldertap.app/join#inboxMOM.invite12.secret1234")
    #expect(preview == InvitePreview(name: "Mom", color: .plum, expiresAt: 1_800_000_000_000))
    #expect(log.value.last == "GET /v1/invites/preview?code=inboxMOM.invite12.secret1234 -")
  }

  @Test func acceptingKeepsTheNewKeyAndSaysWho() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/accept"
        ? (200, #"{"person":{"name":"Mom","color":"plum"},"sender":{"id":"inboxMOM:mom11111","grant":{"kind":"sender","credentialId":"mom11111","token":"inboxMOM.key11111.secret222","recipientName":"Mom"},"name":"Jake","color":"moss"},"mutual":true}"#)
        : (200, jakeMe)
    }
    let persistence = MemorySenderPersistence()
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { _ in (503, "{}") })
    let result = try await account.accept(
      code: "shouldertap://join#inboxMOM.invite12.secret1234", platform: .iphone, deviceName: "Jake’s iPhone", senders: senders)
    #expect(result.person.name == "Mom")
    #expect(result.mutual)
    #expect(bodies["/account/accept"] == ["code": "inboxMOM.invite12.secret1234", "platform": "iphone", "deviceName": "Jake’s iPhone"])
    #expect(persistence.loadPairings().map(\.token) == ["inboxMOM.key11111.secret222"])
    #expect(senders.sessions.map(\.pairing.recipientName) == ["Mom"])
  }

  @Test func yourOwnInviteSaysSo() async throws {
    let account = try await signedIn { request in
      request.url!.path == "/account/accept" ? (400, #"{"error":"That's your own invite"}"#) : (200, jakeMe)
    }
    let senders = SenderStore(server: api, persistence: MemorySenderPersistence(), session: StubProtocol.session { _ in (503, "{}") })
    do {
      _ = try await account.accept(code: "inboxAAA.invite12.secret1234", platform: .mac, deviceName: "Mac", senders: senders)
      Issue.record("accepting your own invite should fail")
    } catch { #expect(error.localizedDescription == "That's your own invite") }
  }
}

@Suite(.serialized) @MainActor struct AccountRemove {
  private let mom = SenderPairing(
    token: "inboxMOM.key11111.secret222", credentialId: "mom11111", recipientName: "Mom", senderName: "Jake",
    color: .moss, pairedAt: 1)

  @Test func removingEndsTheConnectionOnTheAccountNotJustThisKey() async throws {
    let log = Log()
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/remove" ? (200, #"{"removed":true}"#) : (200, jakeMe)
    }
    let persistence = MemorySenderPersistence(pairings: [mom])
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { request in
      log.record(request); return (503, "{}")
    })
    senders.start()
    try await account.remove("mom11111", senders: senders)
    #expect(bodies["/account/remove"] == ["id": "inboxMOM:mom11111"])
    #expect(persistence.loadPairings().count == 0)
    #expect(senders.sessions.count == 0)
    try await Task.sleep(for: .milliseconds(100))
    #expect(!log.value.contains { $0.hasPrefix("DELETE") })
  }

  @Test func aPairingTheAccountNeverHadIsRevokedInstead() async throws {
    let log = Log()
    let account = try await signedIn { request in
      request.url!.path == "/account/remove" ? (404, #"{"error":"No such person"}"#) : (200, jakeMe)
    }
    let persistence = MemorySenderPersistence(pairings: [mom])
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { request in
      log.record(request)
      return request.httpMethod == "DELETE" ? (200, #"{"revoked":true}"#) : (503, "{}")
    })
    senders.start()
    try await account.remove("mom11111", senders: senders)
    #expect(persistence.loadPairings().count == 0)
    let revoke = "DELETE /v1/credentials/key11111 Bearer inboxMOM.key11111.secret222"
    for _ in 0..<100 where !log.value.contains(revoke) {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(log.value.contains(revoke))
  }
}
