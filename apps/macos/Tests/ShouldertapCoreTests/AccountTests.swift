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

}
