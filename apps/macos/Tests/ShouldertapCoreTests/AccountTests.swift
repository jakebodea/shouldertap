import Foundation
import Testing
@testable import ShouldertapCore

@Suite @MainActor struct AccountBehavior {
  @Test func accountListsDistinctInboxesAndUsesSessionBearer() async throws {
    let vault = MemoryVault()
    try vault.write("account-session")
    let session = StubProtocol.session { request in
      guard request.value(forHTTPHeaderField: "Authorization") == "Bearer account-session" else {
        return (401, #"{"error":"unauthorized"}"#)
      }
      if request.url?.path == "/api/auth/get-session" {
        return (200, #"{"user":{"email":"jake@example.com"}}"#)
      }
      return (200, #"{"inboxes":[{"id":"a","inboxId":"a","name":"Jake"},{"id":"b","inboxId":"b","name":"Jake"}],"senders":[],"patrons":[],"defaultInboxId":"b"}"#)
    }
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault, session: session)
    await account.refresh()
    #expect(account.email == "jake@example.com")
    #expect(account.data?.inboxes.map(\.id) == ["a", "b"])
    #expect(account.data?.defaultInboxId == "b")
  }

  @Test func deviceCodeExposesIndependentBrowserConfirmation() async {
    let session = StubProtocol.session { _ in
      (200, #"{"device_code":"secret-device","user_code":"ABCD-EFGH","verification_uri_complete":"https://api.test/account/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}"#)
    }
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-mac", vault: MemoryVault(), session: session)
    let url = await account.begin()
    #expect(url?.host == "api.test")
    #expect(account.authorization?.user_code == "ABCD-EFGH")
    #expect(account.authorization?.interval == 5)
  }
  @Test func switchingInboxPersistsTheSelectedCredential() throws {
    let persistence = MemoryPersistence(credential: "oldInbox.device123.secret123")
    let store = ReceiverStore(
      endpoints: Endpoints(server: URL(string: "https://api.test")!, web: URL(string: "https://web.test")!),
      persistence: persistence, deviceName: { "Test Mac" },
      session: StubProtocol.session { _ in (503, "{}") })
    let grant = CredentialGrant(kind: .device, credentialId: "nextDevice", token: "newInbox.nextDevice.secret456", recipientName: "Jake")
    try store.restoreAccountInbox(grant)
    #expect(persistence.loadCredential() == "newInbox.nextDevice.secret456")
    #expect(store.phase == .ready)
  }

  @Test func switchingReusesAValidatedSavedDeviceWithoutRestoringAgain() async throws {
    let backup = MemoryVault()
    try backup.write("savedInbox.device123.secret123")
    let session = StubProtocol.session { request in
      if request.url?.path == "/account/data" {
        return (200, #"{"inboxes":[{"id":"savedInbox","name":"Jamie"}],"senders":[],"patrons":[],"defaultInboxId":null}"#)
      }
      if request.url?.path == "/v1/me", request.value(forHTTPHeaderField: "Authorization") == "Bearer savedInbox.device123.secret123" {
        return (200, #"{"kind":"device","credentialId":"device123","recipientName":"Jamie","sequence":1,"taps":[],"credentials":[]}"#)
      }
      return (409, #"{"error":"Must reuse saved key; restoring would consume another device slot"}"#)
    }
    let persistence = MemoryPersistence()
    let receiver = ReceiverStore(endpoints: Endpoints(server: URL(string: "https://api.test")!, web: URL(string: "https://web.test")!),
      persistence: persistence, deviceName: { "Test Mac" }, session: session)
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-mac", vault: MemoryVault(), session: session, inboxVault: { _ in backup })
    try await account.receiveInbox(id: "savedInbox", inbox: receiver, deviceName: "Test Mac", platform: "mac")
    #expect(persistence.loadCredential() == "savedInbox.device123.secret123")
    #expect(account.data?.inboxes.first?.name == "Jamie")
  }

  @Test func deletingAccountAllowsANewUnauthenticatedSignIn() async throws {
    let vault = MemoryVault()
    try vault.write("account-session")
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: StubProtocol.session { request in
        if request.url?.path == "/api/auth/delete-user", request.value(forHTTPHeaderField: "Authorization") == "Bearer account-session" {
          return (200, #"{"success":true,"message":"User deleted"}"#)
        }
        if request.url?.path == "/api/auth/device/code", request.value(forHTTPHeaderField: "Authorization") == nil {
          return (200, #"{"device_code":"new-code","user_code":"ABCD-EFGH","verification_uri_complete":"https://api.test/account/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}"#)
        }
        return (403, #"{"error":"Forbidden"}"#)
      })
    await account.deleteAccount()
    let url = await account.begin()
    #expect(url?.absoluteString == "https://api.test/account/device?user_code=ABCD-EFGH")
  }

  @Test func switchingReplacesARevokedSavedKeyWithANewDevice() async throws {
    let backup = MemoryVault()
    try backup.write("savedInbox.device123.secret123")
    let session = StubProtocol.session { request in
      switch request.url?.path {
      case "/account/data":
        return (200, #"{"inboxes":[{"id":"savedInbox","name":"Jamie"}],"senders":[],"patrons":[],"defaultInboxId":null}"#)
      case "/v1/me": return (401, #"{"message":"This pairing is no longer valid"}"#)
      case "/account/restore":
        return (200, #"{"kind":"device","credentialId":"newDevice","token":"savedInbox.newDevice.secret456","recipientName":"Jamie"}"#)
      default: return (503, "{}")
      }
    }
    let persistence = MemoryPersistence()
    let receiver = ReceiverStore(endpoints: Endpoints(server: URL(string: "https://api.test")!, web: URL(string: "https://web.test")!),
      persistence: persistence, deviceName: { "Test Mac" }, session: session)
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-mac", vault: MemoryVault(), session: session, inboxVault: { _ in backup })
    try await account.receiveInbox(id: "savedInbox", inbox: receiver, deviceName: "Test Mac", platform: "mac")
    #expect(persistence.loadCredential() == "savedInbox.newDevice.secret456")
    #expect(backup.read() == "savedInbox.newDevice.secret456")
  }


  @Test func signInFinishesWithoutAnyViewWaiting() async {
    let calls = Calls()
    let vault = MemoryVault()
    let session = StubProtocol.session { request in
      let attempt = calls.record(request)
      switch request.url?.path {
      case "/api/auth/device/code":
        return (200, #"{"device_code":"secret-device","user_code":"ABCD-EFGH","verification_uri_complete":"https://api.test/account/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}"#)
      case "/api/auth/device/token":
        return attempt == 1 ? (400, #"{"error":"authorization_pending"}"#) : (200, #"{"access_token":"approved-session"}"#)
      case "/api/auth/get-session": return (200, #"{"user":{"email":"jake@example.com"}}"#)
      default: return (200, #"{"inboxes":[],"senders":[],"patrons":[],"defaultInboxId":null}"#)
      }
    }
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-mac", vault: vault,
      session: session, sleep: { _ in })
    await account.begin()
    await account.waitForSignIn()
    #expect(account.email == "jake@example.com")
    #expect(vault.read() == "approved-session")
    #expect(calls.count("/api/auth/device/token") == 2)
    #expect(account.authorization == nil)
  }

  @Test func cancelingStopsWaitingForApproval() async {
    let calls = Calls()
    let session = StubProtocol.session { request in
      _ = calls.record(request)
      if request.url?.path == "/api/auth/device/code" {
        return (200, #"{"device_code":"secret-device","user_code":"ABCD-EFGH","verification_uri_complete":"https://api.test/account/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}"#)
      }
      return (200, #"{"access_token":"approved-session"}"#)
    }
    let vault = MemoryVault()
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: session, sleep: { _ in })
    await account.begin()
    account.cancel()
    await account.waitForSignIn()
    #expect(calls.count("/api/auth/device/code") == 1)
    #expect(calls.count("/api/auth/device/token") == 0)
    #expect(vault.read() == nil)
  }

  @Test func declinedSignInSaysSoInPlainWords() async {
    let session = StubProtocol.session { request in
      if request.url?.path == "/api/auth/device/code" {
        return (200, #"{"device_code":"secret-device","user_code":"ABCD-EFGH","verification_uri_complete":"https://api.test/account/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}"#)
      }
      return (400, #"{"error":"access_denied","error_description":"The user denied the request"}"#)
    }
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: MemoryVault(),
      session: session, sleep: { _ in })
    await account.begin()
    await account.waitForSignIn()
    #expect(account.error == "Sign-in was declined in the browser.")
  }

  @Test func expiredAccountSessionAsksToSignInAgain() async throws {
    let vault = MemoryVault()
    try vault.write("old-session")
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: StubProtocol.session { _ in (401, #"{"error":"Sign in to continue"}"#) })
    await account.refresh()
    #expect(account.error == "Your sign-in expired. Sign in again.")
    #expect(vault.read() == nil)
  }

  @Test func serverWordingIsTranslatedForPeople() {
    #expect(accountMessage("Origin required") == "That didn’t work. Try again.")
    #expect(accountMessage("expired_token") == "This sign-in code expired. Start again.")
    #expect(accountMessage("invalid_grant") == "This sign-in didn’t work. Start again.")
    #expect(accountMessage("Membership does not belong to this account", status: 401) == "Your sign-in expired. Sign in again.")
    #expect(accountMessage("Wait for your pending replies to send before switching inboxes.") == "Wait for your pending replies to send before switching inboxes.")
  }

  @Test func savingReportsSuccessAndCoversThisDevicesConnections() async throws {
    let vault = MemoryVault()
    try vault.write("account-session")
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: StubProtocol.session { request in
        if request.url?.path == "/api/auth/get-session" { return (200, #"{"user":{"email":"jake@example.com"}}"#) }
        if request.url?.path == "/account/adopt" {
          return (200, #"{"inboxes":[{"id":"inboxAAA","inboxId":"inboxAAA","name":"Jake"}],"senders":[{"id":"inboxBBB:sender11","inboxId":"inboxBBB","name":"Mom"}],"patrons":[],"defaultInboxId":"inboxAAA"}"#)
        }
        return (200, #"{"inboxes":[],"senders":[],"patrons":[],"defaultInboxId":null}"#)
      })
    await account.refresh()
    #expect(account.hasUnsaved(inboxToken: "inboxAAA.device11.secret11"))
    await account.adopt(tokens: ["inboxAAA.device11.secret11", "inboxBBB.sender11.secret22"])
    #expect(account.notice == "Saved to your account.")
    #expect(!account.hasUnsaved(inboxToken: "inboxAAA.device11.secret11", senders: [SenderPairing(token: "inboxBBB.sender11.secret22", credentialId: "sender11", recipientName: "Mom", senderName: "Jake", color: nil, pairedAt: 1)]))
    #expect(account.hasUnsaved(inboxToken: "inboxCCC.sender99.secret33"))
  }

  @Test func savedStatusSeparatesReceiverOwnershipAndCanonicalSenderIdentity() async throws {
    let vault = MemoryVault()
    try vault.write("account-session")
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: StubProtocol.session { request in
        if request.url?.path == "/api/auth/get-session" { return (200, #"{"user":{"email":"jake@example.com"}}"#) }
        return (200, #"{"inboxes":[{"id":"inboxAAA","name":"Jake"}],"senders":[{"id":"inboxAAA:sender11","inboxId":"inboxAAA","name":"Jake"},{"id":"inboxBBB:sender22","inboxId":"inboxBBB","name":"Mom"}],"patrons":[],"defaultInboxId":null}"#)
      })
    await account.refresh()
    func sender(_ inbox: String, canonical: String, key: String) -> SenderPairing {
      SenderPairing(token: "\(inbox).\(key).secret11", credentialId: canonical, recipientName: "Recipient", senderName: "Jake", color: nil, pairedAt: 1)
    }
    #expect(account.email == "jake@example.com")
    #expect(!account.hasUnsaved(inboxToken: "inboxAAA.device11.secret11"))
    // An account-owned receiver does not cover another sender to that inbox.
    #expect(account.hasUnsaved(inboxToken: nil, senders: [sender("inboxAAA", canonical: "sender99", key: "sender99")]))
    // A saved sender does not cover a local receiver of the same inbox.
    #expect(account.hasUnsaved(inboxToken: "inboxBBB.device11.secret11"))
    // The canonical sender identity covers its separately issued recovery key.
    #expect(!account.hasUnsaved(inboxToken: nil, senders: [sender("inboxBBB", canonical: "sender22", key: "alias111")]))
    #expect(account.hasUnsaved(inboxToken: nil, senders: [sender("inboxBBB", canonical: "sender99", key: "alias999")]))
  }

  @Test func successfulRefreshReplacesAStaleFailureWithLoadedAccount() async throws {
    let vault = MemoryVault()
    try vault.write("account-session")
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: StubProtocol.session { request in
        if request.url?.path == "/api/auth/get-session" { return (200, #"{"user":{"email":"jake@example.com"}}"#) }
        return (200, #"{"inboxes":[{"id":"inboxAAA","name":"Jake"}],"senders":[],"patrons":[],"defaultInboxId":null}"#)
      })
    account.error = "Couldn’t reach Shouldertap. Check your connection and try again."
    await account.refresh()
    #expect(account.email == "jake@example.com")
    #expect(account.data?.inboxes.first?.name == "Jake")
    #expect(account.error == nil)
  }

  @Test func nullSessionExpiresLocallyAndAllowsANewSignIn() async throws {
    let vault = MemoryVault()
    try vault.write("expired-session")
    let account = AccountStore(server: URL(string: "https://api.test")!, clientID: "shouldertap-ios", vault: vault,
      session: StubProtocol.session { request in
        if request.url?.path == "/api/auth/get-session" { return (200, "null") }
        if request.url?.path == "/api/auth/device/code", request.value(forHTTPHeaderField: "Authorization") == nil {
          return (200, #"{"device_code":"new-code","user_code":"ABCD-EFGH","verification_uri_complete":"https://api.test/account/device?user_code=ABCD-EFGH","expires_in":600,"interval":5}"#)
        }
        return (503, "{}")
      })
    await account.refresh()
    #expect(account.error == "Your sign-in expired. Sign in again.")
    let url = await account.begin()
    #expect(url?.absoluteString == "https://api.test/account/device?user_code=ABCD-EFGH")
    account.cancel()
  }

}
