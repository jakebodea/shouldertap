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

  @Test func syncKeepsEveryPairingLookingTheWayTheAccountSays() async throws {
    let account = try await signedIn { request in
      switch request.url!.path {
      case "/account/sync":
        return (200, #"""
          {"me":\#(jakeMe),"inbox":null,
           "senders":[{"id":"inboxDAD:dad11111","grant":{"kind":"sender","credentialId":"dad11111","token":"inboxDAD.key22222.secret444","recipientName":"Dad"},"name":"Jake","color":"moss","theme":"note","chooseSeenAs":true}],
           "removed":[],
           "connections":[
             {"id":"inboxMOM:mom11111","name":"Your son","color":"sky","theme":"terminal","chooseSeenAs":false},
             {"id":"inboxDAD:dad11111","name":"Jake","color":"moss","theme":"note","chooseSeenAs":true}]}
          """#)
      default: return (200, jakeMe)
      }
    }
    let persistence = MemorySenderPersistence(pairings: [SenderPairing(
      token: "inboxMOM.key11111.secret222", credentialId: "mom11111", recipientName: "Mom", senderName: "Jake",
      color: .moss, pairedAt: 1)])
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { _ in (503, "{}") })
    senders.start()
    await account.sync(platform: .mac, deviceName: "Mac", inbox: nil, senders: senders)
    let looks = senders.sessions.map { [$0.pairing.recipientName, $0.pairing.senderName, $0.pairing.theme?.rawValue] }
    #expect(looks == [["Mom", "Your son", "terminal"], ["Dad", "Jake", "note"]])
    #expect(senders.sessions.map(\.pairing.chooseSeenAs) == [false, true])
    #expect(persistence.loadPairings().first { $0.credentialId == "mom11111" }?.theme == .terminal)
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

  @Test func acceptingCanPickHowJustThisPersonSeesYou() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/accept"
        ? (200, #"{"person":{"name":"Mom","color":"plum"},"sender":{"id":"inboxMOM:mom11111","grant":{"kind":"sender","credentialId":"mom11111","token":"inboxMOM.key11111.secret222","recipientName":"Mom"},"name":"Your son","color":"sky"},"mutual":true}"#)
        : (200, jakeMe)
    }
    let persistence = MemorySenderPersistence()
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { _ in (503, "{}") })
    _ = try await account.accept(
      code: "inboxMOM.invite12.secret1234", profile: Profile(name: "Your son", color: .sky), platform: .iphone,
      deviceName: "Jake’s iPhone", senders: senders)
    #expect(bodies["/account/accept"]?["profile"] as? [String: String] == ["name": "Your son", "color": "sky"])
    #expect(persistence.loadPairings().map(\.senderName) == ["Your son"])
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

@Suite(.serialized) @MainActor struct AccountSendProfile {
  private let mom = SenderPairing(
    token: "inboxMOM.key11111.secret222", credentialId: "mom11111", recipientName: "Mom", senderName: "Jake",
    color: .moss, pairedAt: 1)

  @Test func newConnectionsStartWithTheLatestProfile() async throws {
    let account = try await signedIn { _ in
      (200, #"{"email":"jake@example.com","profile":{"name":"Jake","color":"moss"},"sendProfile":{"name":"Coach","color":"ochre"},"suggestedName":null,"inboxId":"inboxAAA"}"#)
    }
    #expect(account.me?.sendProfile == Profile(name: "Coach", color: .ochre))
  }

  @Test func changingHowOnePersonSeesYouSavesItForThem() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/send-profile"
        ? (200, #"{"id":"inboxMOM:mom11111","name":"Your son","color":"sky"}"#) : (200, jakeMe)
    }
    let persistence = MemorySenderPersistence(pairings: [mom])
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { _ in (503, "{}") })
    senders.start()
    try await account.updateSendProfile("mom11111", name: " Your son ", color: .sky, senders: senders)
    #expect(bodies["/account/send-profile"] == ["id": "inboxMOM:mom11111", "name": "Your son", "color": "sky"])
    #expect(persistence.loadPairings().map { [$0.senderName, $0.color?.rawValue] } == [["Your son", "sky"]])
  }

  @Test func choosingAThemeForOnePersonAnswersTheAsk() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/send-profile"
        ? (200, #"{"id":"inboxMOM:mom11111","name":"Jake","color":"moss","theme":"billboard"}"#) : (200, jakeMe)
    }
    var asked = mom
    asked.chooseSeenAs = true
    let persistence = MemorySenderPersistence(pairings: [asked])
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { _ in (503, "{}") })
    senders.start()
    try await account.updateSendProfile("mom11111", name: "Jake", color: .moss, theme: .billboard, senders: senders)
    #expect(bodies["/account/send-profile"] == ["id": "inboxMOM:mom11111", "name": "Jake", "color": "moss", "theme": "billboard"])
    let saved = try #require(persistence.loadPairings().first)
    #expect(saved.theme == .billboard)
    #expect(saved.chooseSeenAs == false)
  }

  private let dad = SenderPairing(
    token: "inboxDAD.key22222.secret444", credentialId: "dad11111", recipientName: "Dad", senderName: "Jake",
    color: .moss, pairedAt: 2)

  /// A patron on this Mac whose own theme is Note; `sendProfile` answers
  /// `/account/send-profile`.
  private func patronWithNote(
    _ sendProfile: (Int, String), bodies: Bodies
  ) async throws -> (PatronStore, SenderStore) {
    let account = try await signedIn { request in
      bodies.record(request)
      switch request.url!.path {
      case "/account/send-profile": return sendProfile
      case "/account/patron/status":
        return (
          200,
          #"{"memberships":[{"id":"patron01","status":{"patron":{"active":true,"status":"active","paidUntil":1824135813255}}}],"checkoutEnabled":true}"#
        )
      case "/account/restore": return (200, #"{"key":"stp1.patron01.key00002.secret"}"#)
      default: return (200, jakeMe)
      }
    }
    let patron = PatronStore(
      account: account, vault: MemoryVault(), defaults: UserDefaults(suiteName: "patron-\(UUID().uuidString)")!)
    patron.theme = .note
    await patron.refresh()
    let senders = SenderStore(
      server: api, persistence: MemorySenderPersistence(pairings: [mom, dad]),
      session: StubProtocol.session { _ in (503, "{}") })
    senders.start()
    return (patron, senders)
  }

  @Test func choosingATapStyleForOnePersonLeavesTheOthersOnThisMacsStyle() async throws {
    let bodies = Bodies()
    let (patron, senders) = try await patronWithNote(
      (200, #"{"id":"inboxMOM:mom11111","name":"Jake","color":"moss","theme":"terminal"}"#), bodies: bodies)
    try await patron.choose(.terminal, for: "mom11111", senders: senders)
    #expect(bodies["/account/send-profile"] == ["id": "inboxMOM:mom11111", "name": "Jake", "color": "moss", "theme": "terminal"])
    let looks = senders.sessions.map { [$0.pairing.recipientName, patron.theme(for: $0.pairing).rawValue] }
    #expect(looks == [["Mom", "terminal"], ["Dad", "note"]])
  }

  @Test func aPersonTheAccountDoesntHoldChangesThisMacsStyle() async throws {
    let (patron, senders) = try await patronWithNote((404, #"{"error":"No such person"}"#), bodies: Bodies())
    try await patron.choose(.billboard, for: "mom11111", senders: senders)
    let looks = senders.sessions.map { [$0.pairing.recipientName, patron.theme(for: $0.pairing).rawValue] }
    #expect(looks == [["Mom", "billboard"], ["Dad", "billboard"]])
  }

  @Test func withoutAMembershipEveryoneGetsDefault() async throws {
    let account = try await signedIn { _ in (200, jakeMe) }
    let patron = PatronStore(
      account: account, vault: MemoryVault(), defaults: UserDefaults(suiteName: "patron-\(UUID().uuidString)")!)
    patron.theme = .note
    var themed = mom
    themed.theme = .terminal
    #expect([patron.theme(for: themed), patron.theme(for: dad)] == [.default, .default])
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

  @Test func removingCanDeleteYourTapsToo() async throws {
    let bodies = Bodies()
    let account = try await signedIn { request in
      bodies.record(request)
      return request.url!.path == "/account/remove" ? (200, #"{"removed":true}"#) : (200, jakeMe)
    }
    let persistence = MemorySenderPersistence(pairings: [mom])
    let senders = SenderStore(server: api, persistence: persistence, session: StubProtocol.session { _ in (503, "{}") })
    senders.start()
    try await account.remove("mom11111", deleteData: true, senders: senders)
    #expect(bodies["/account/remove"] == ["id": "inboxMOM:mom11111", "deleteData": true])
    #expect(persistence.loadPairings().count == 0)
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

@Suite struct SignInCodesScanned {
  @Test func aSignInQRCodeGivesItsToken() {
    #expect(qrSignInToken(from: "https://shouldertap.app/qr#Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56") == "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56")
    #expect(qrSignInToken(from: " shouldertap://qr#Ab12Cd34Ef56Gh78\n") == "Ab12Cd34Ef56Gh78")
    #expect(qrSignInToken(from: "https://shouldertap.app/join#in/1#a") == nil)
    #expect(qrSignInToken(from: "https://shouldertap.app/qr#short") == nil)
    #expect(qrSignInToken(from: "https://shouldertap.app/qr/x#Ab12Cd34Ef56Gh78") == nil)
    #expect(qrSignInToken(from: "http://shouldertap.app/qr#Ab12Cd34Ef56Gh78") == nil)
  }

  @Test func aDeviceSignInQRCodeGivesItsUserCode() {
    #expect(deviceSignInCode(from: "https://api.shouldertap.app/account/device?user_code=ABCD1234") == "ABCD1234")
    #expect(deviceSignInCode(from: "http://api.shouldertap.app/account/device?user_code=X") == nil)
    #expect(deviceSignInCode(from: "https://api.shouldertap.app/account/device") == nil)
    #expect(deviceSignInCode(from: "https://shouldertap.app/join#inboxAAA.key11111.secret222") == nil)
  }

  @Test func devicesAreNamedTheWayPeopleSayThem() {
    #expect(SignInDevice(client: "shouldertap-mac")?.rawValue == "Mac")
    #expect(SignInDevice(client: "shouldertap-windows")?.rawValue == "PC")
    #expect(SignInDevice(client: "shouldertap-web")?.rawValue == "browser")
    #expect(SignInDevice(client: "someone-else") == nil)
    #expect(SignInDevice(platform: "iphone")?.rawValue == "iPhone")
  }
}

@Suite(.serialized) @MainActor struct AccountQRSignIn {
  private let qrLink = "https://shouldertap.app/qr#Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"

  @Test func scanningAComputersCodeSignsInLikeAnEmailedCode() async {
    let vault = MemoryVault()
    let log = Log()
    let bodies = Bodies()
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { request in
      log.record(request); bodies.record(request)
      switch request.url!.path {
      case "/api/auth/qr-sign-in/redeem": return (200, #"{"token":"phone-session","user":{"email":"jake@example.com"}}"#)
      default: return (200, newMe)
      }
    })
    #expect(await account.signIn(scanned: qrLink, platform: .iphone))
    #expect(vault.read() == "phone-session")
    #expect(account.me?.suggestedName == "Jake B")
    #expect(bodies["/api/auth/qr-sign-in/redeem"] == ["token": "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56", "platform": "iphone"])
    #expect(log.value == ["POST /api/auth/qr-sign-in/redeem -", "GET /account/me Bearer phone-session"])
  }

  @Test func anExpiredCodeSaysToShowANewOne() async {
    let vault = MemoryVault()
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { _ in
      (400, #"{"message":"That code expired. Show a new one and scan again."}"#)
    })
    #expect(await account.signIn(scanned: qrLink, platform: .iphone) == false)
    #expect(account.error == "That code expired. Show a new one and scan again.")
    #expect(vault.read() == nil)
  }

  @Test func theComputerShowsACodeAndSeesWhoUsedIt() async throws {
    let log = Log()
    let account = try await signedIn { request in
      log.record(request)
      switch request.url!.path {
      case "/api/auth/qr-sign-in/create":
        return (200, #"{"token":"Ab12Cd34Ef56Gh78","url":"https://shouldertap.app/qr#Ab12Cd34Ef56Gh78","expiresAt":1790000000000}"#)
      case "/api/auth/qr-sign-in/status": return (200, #"{"status":"used","platform":"iphone"}"#)
      default: return (200, jakeMe)
      }
    }
    let qr = try await account.createQrSignIn()
    let status = try await account.qrSignInStatus(token: qr.token)
    #expect(qr.url == "https://shouldertap.app/qr#Ab12Cd34Ef56Gh78")
    #expect(status.status == .used)
    #expect(status.device == .iPhone)
    #expect(log.value.suffix(2) == [
      "POST /api/auth/qr-sign-in/create Bearer account-session",
      "POST /api/auth/qr-sign-in/status Bearer account-session",
    ])
  }

  /// The server refuses a cookie without an Origin, which only browsers send:
  /// the bearer is the session, and no cookie is sent or kept.
  @Test func sendsTheBearerButNeverASessionCookie() async throws {
    let server = try await LocalServer { head in
      head.hasPrefix("POST /api/auth/qr-sign-in/create ")
        ? (["Set-Cookie: session_token=fresh; Path=/"], #"{"token":"Ab12Cd34Ef56Gh78","url":"https://shouldertap.app/qr#Ab12Cd34Ef56Gh78","expiresAt":1790000000000}"#)
        : (["Set-Cookie: session_token=fresh; Path=/"], jakeMe)
    }
    defer { server.stop() }
    let config = URLSessionConfiguration.ephemeral
    let jar = config.httpCookieStorage!
    jar.setCookie(HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "session_token", .value: "saved"])!)
    let vault = MemoryVault()
    try vault.write("account-session")
    let account = AccountStore(server: server.url, vault: vault, session: URLSession(configuration: config))

    let qr = try await account.createQrSignIn()

    let create = try #require(server.requests.first { $0.hasPrefix("POST /api/auth/qr-sign-in/create ") })
    let headers = create.lowercased()
    #expect(qr.token == "Ab12Cd34Ef56Gh78")
    #expect(headers.contains("authorization: bearer account-session"))
    #expect(!headers.contains("cookie:"))
    #expect(jar.cookies?.map(\.value) == ["saved"])
  }

  @Test func aComputerWaitsSlowsDownThenSignsInOnceThePhoneApproves() async throws {
    let vault = MemoryVault()
    let bodies = Bodies()
    let replies = Replies([
      (400, #"{"error":"authorization_pending","error_description":"waiting"}"#),
      (400, #"{"error":"slow_down"}"#),
      (200, #"{"access_token":"mac-session","token_type":"Bearer"}"#),
    ])
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { request in
      bodies.record(request)
      switch request.url!.path {
      case "/api/auth/device/code":
        return (200, #"{"device_code":"dev-1","user_code":"WXYZ2345","verification_uri":"https://api.test/account/device","verification_uri_complete":"https://api.test/account/device?user_code=WXYZ2345","interval":5,"expires_in":600}"#)
      case "/api/auth/device/token": return replies.next()
      default: return (200, jakeMe)
      }
    })
    let started = try await account.startDeviceSignIn(client: .mac, now: Date(timeIntervalSince1970: 1000))
    #expect(started.userCode == "WXYZ2345")
    #expect(started.url == "https://api.test/account/device?user_code=WXYZ2345")
    #expect(started.expiresAt == Date(timeIntervalSince1970: 1600))
    #expect(bodies["/api/auth/device/code"] == ["client_id": "shouldertap-mac"])
    #expect(try await account.pollDeviceSignIn(started) == .pending(interval: 5))
    #expect(try await account.pollDeviceSignIn(started, interval: 5) == .pending(interval: 10))
    #expect(try await account.pollDeviceSignIn(started, interval: 10) == .signedIn)
    #expect(bodies["/api/auth/device/token"] == [
      "client_id": "shouldertap-mac", "device_code": "dev-1",
      "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    ])
    #expect(vault.read() == "mac-session")
    #expect(account.email == "jake@example.com")
    #expect(account.me?.profile?.name == "Jake")
  }

  @Test func aDeniedOrStaleCodeSaysSo() async throws {
    let replies = Replies([
      (400, #"{"error":"access_denied"}"#), (400, #"{"error":"expired_token"}"#), (400, #"{"error":"invalid_grant"}"#),
    ])
    let vault = MemoryVault()
    let account = AccountStore(server: api, vault: vault, session: StubProtocol.session { _ in replies.next() })
    let started = DeviceSignIn(
      client: .windows, deviceCode: "dev-1", userCode: "WXYZ2345",
      url: "https://api.test/account/device?user_code=WXYZ2345", interval: 5, expiresAt: .distantFuture)
    #expect(try await account.pollDeviceSignIn(started) == .denied)
    #expect(try await account.pollDeviceSignIn(started) == .expired)
    #expect(try await account.pollDeviceSignIn(started) == .expired)
    #expect(vault.read() == nil)
  }

  @Test func thePhoneReviewsThenApprovesTheCodeItScanned() async throws {
    let log = Log()
    let bodies = Bodies()
    let account = try await signedIn { request in
      log.record(request); bodies.record(request)
      switch request.url!.path {
      case "/api/auth/device": return (200, #"{"user_code":"WXYZ2345","client_id":"shouldertap-mac","status":"pending"}"#)
      case "/api/auth/device/approve", "/api/auth/device/deny": return (200, #"{"success":true}"#)
      default: return (200, jakeMe)
      }
    }
    let code = try #require(deviceSignInCode(from: "https://api.test/account/device?user_code=WXYZ2345"))
    let review = try await account.reviewDeviceSignIn(userCode: code)
    try await account.approveDeviceSignIn(userCode: code)
    try await account.denyDeviceSignIn(userCode: code)
    #expect(review == DeviceSignInReview(userCode: "WXYZ2345", device: .Mac, pending: true))
    #expect(bodies["/api/auth/device/approve"] == ["userCode": "WXYZ2345"])
    #expect(bodies["/api/auth/device/deny"] == ["userCode": "WXYZ2345"])
    #expect(log.value.suffix(3) == [
      "GET /api/auth/device?user_code=WXYZ2345 Bearer account-session",
      "POST /api/auth/device/approve Bearer account-session",
      "POST /api/auth/device/deny Bearer account-session",
    ])
  }
}

/// A fake server's answers, one per request, in order.
private final class Replies: @unchecked Sendable {
  private let lock = NSLock()
  private var queue: [(Int, String)]
  init(_ queue: [(Int, String)]) { self.queue = queue }
  func next() -> (status: Int, body: String) {
    lock.withLock { queue.isEmpty ? (500, "{}") : queue.removeFirst() }
  }
}
