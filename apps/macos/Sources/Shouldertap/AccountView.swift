import SwiftUI
import ShouldertapCore
import AppKit

struct AccountView: View {
  let account: AccountStore
  let inbox: ReceiverStore
  
  @Environment(\.openURL) private var openURL
  @State private var patronAvailable = false
  @State private var selectedInbox: AccountIdentity?
  @State private var confirmDeletion = false
  var body: some View {
    Form {
      Section {
        if let email = account.email {
          Text(email)
          Button("Attach this device’s existing inbox and connections") {
            Task { await account.adopt(tokens: [inbox.accountCredential].compactMap { $0 }) }
          }
          Text("Attaching keeps each inbox separate. Choose which one to receive here.")
            .font(.caption)
          if let data = account.data {
            ForEach(data.inboxes) { identity in
              HStack {
                Text(identity.name)
                if data.defaultInboxId == identity.id { Text("Default").font(.caption) }
                Spacer()
                Button("Receive here") { selectedInbox = identity }
                  .disabled(inbox.accountCredential.flatMap(tokenInboxId) == identity.id)
                Button("Make default") { Task { await account.setDefault(identity.id) } }
                  .disabled(data.defaultInboxId == identity.id)
              }
            }
            
          }
          if patronAvailable {
            Link("Patron support and style", destination: account.server.appending(path: "/account").appending(queryItems: [URLQueryItem(name: "section", value: "patron")]))
          }
          Button("Open account in browser") { openURL(account.server.appending(path: "/account")) }
          Button("Sign out") { Task { await account.signOut() } }
          Button("Delete account", role: .destructive) { confirmDeletion = true }
            .disabled(account.busy)
        } else {
          Text("Use one email account to recover your inboxes and sender connections.")
          Button("Sign in with email") {
            Task { if let url = await account.begin() { openURL(url) } }
          }.disabled(account.busy || account.authorization != nil)
        }
        if let code = account.authorization {
          Text("Confirm this code in your browser: \(code.user_code)").textSelection(.enabled)
          Link("Continue in browser", destination: code.verification_uri_complete)
          Button("Cancel sign-in") { account.cancel() }
        }
        if let error = account.error { Text(error).foregroundStyle(.red) }
      } header: { Text("Account") }
    }
    .task { await account.refresh(); patronAvailable = true }
    .confirmationDialog("Receive taps from this inbox?", isPresented: Binding(
      get: { selectedInbox != nil }, set: { if !$0 { selectedInbox = nil } }
    ), titleVisibility: .visible) {
      if let identity = selectedInbox {
        Button("Receive from \(identity.name)") { restore(identity, kind: "inbox") }
      }
      Button("Cancel", role: .cancel) { selectedInbox = nil }
    } message: {
      Text("This device will receive the selected inbox. Your current inbox stays separate and is attached to your account before switching, so you can choose it again.")
    }
    .confirmationDialog("Delete your account?", isPresented: $confirmDeletion, titleVisibility: .visible) {
      Button("Delete account", role: .destructive) { Task { await account.deleteAccount() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Permanently deletes your account and its recovery links. Existing inboxes and sender connections stay on this device. Manage any active subscription before deleting. You may need to sign in again.")
    }
    .task(id: account.authorization?.device_code) { await account.finishSignIn() }
  }
  private func restore(_ identity: AccountIdentity, kind: String) {
    Task {
      do {
        if kind == "inbox" {
          try await account.receiveInbox(id: identity.id, inbox: inbox, deviceName: Host.current().localizedName ?? "Mac", platform: "mac")
        }
      } catch { account.error = error.localizedDescription }
    }
  }
}
