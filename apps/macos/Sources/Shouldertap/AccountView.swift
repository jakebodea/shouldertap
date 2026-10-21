import AppKit
import ShouldertapCore
import SwiftUI

/// Account in its own window, like Tap Motion: the popover is transient and
/// closes as soon as the browser opens for sign-in.
@MainActor
final class AccountController {
  private let account: AccountStore
  private let inbox: ReceiverStore
  private var window: NSWindow?

  init(account: AccountStore, inbox: ReceiverStore) {
    self.account = account
    self.inbox = inbox
  }

  func show() {
    if window == nil {
      let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 460, height: 520), styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered, defer: false)
      window.title = "Account"
      window.isReleasedWhenClosed = false
      window.contentView = NSHostingView(rootView: AccountView(account: account, inbox: inbox))
      window.contentMinSize = NSSize(width: 400, height: 360)
      window.center()
      self.window = window
    }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

/// Your email account: recovery for this Mac's inbox. Optional; signing out
/// keeps this Mac set up.
struct AccountView: View {
  let account: AccountStore
  let inbox: ReceiverStore
  @Environment(\.openURL) private var openURL
  @State private var selectedInbox: AccountIdentity?
  @State private var confirmDeletion = false
  @State private var area = Area.top
  @State private var restoring: String?

  private enum Area { case top, device, inboxes, delete }

  var body: some View {
    Form {
      if let email = account.email {
        signedIn(email)
      } else if let code = account.authorization {
        codeCard(code)
      } else if account.isLoading {
        Section { HStack { Spacer(); ProgressView().controlSize(.small); Spacer() } }
      } else {
        Section {
          Text("Restore your inbox on a new Mac or iPhone.")
          Button("Sign in with email") { area = .top; Task { await account.begin() } }
            .disabled(account.busy)
        } footer: { status(.top) }
      }
    }
    .formStyle(.grouped)
    .frame(minWidth: 400, minHeight: 360)
    .task { await account.refresh() }
    .confirmationDialog("Receive taps from this inbox?", isPresented: Binding(
      get: { selectedInbox != nil }, set: { if !$0 { selectedInbox = nil } }
    ), titleVisibility: .visible) {
      if let identity = selectedInbox {
        Button("Receive from \(identity.name)") { receive(identity) }
      }
      Button("Cancel", role: .cancel) { selectedInbox = nil }
    } message: {
      Text("This Mac will receive the selected inbox. Your current inbox stays separate and saved to your account, so you can switch back.")
    }
    .confirmationDialog("Delete your account?", isPresented: $confirmDeletion, titleVisibility: .visible) {
      Button("Delete account", role: .destructive) { area = .delete; Task { await account.deleteAccount() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Deletes your account and its recovery links. Your inbox stays on this Mac. Cancel an active membership first. You may need to sign in again.")
    }
  }

  @ViewBuilder private func codeCard(_ code: DeviceAuthorization) -> some View {
    Section {
      Text(code.user_code)
        .font(.system(size: 34, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .tracking(4)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
      HStack {
        Button("Cancel", role: .cancel) { account.cancel() }
        Spacer()
        Button("Continue in browser") { openURL(code.verification_uri_complete) }
          .keyboardShortcut(.defaultAction)
      }
    } header: {
      Text("Confirm this code in your browser")
    } footer: {
      VStack(alignment: .leading, spacing: 6) {
        Text("Sign in, check that the browser shows the same code, then come back. This updates on its own.")
        status(.top)
      }
    }
  }

  @ViewBuilder private func signedIn(_ email: String) -> some View {
    Section("Signed in as") {
      HStack {
        Text(email)
        Spacer()
        Button("Sign out") { area = .top; Task { await account.signOut() } }
      }
    }
    let tokens = [inbox.accountCredential].compactMap { $0 }
    Section {
      if account.hasUnsaved(inboxToken: inbox.accountCredential) {
        HStack {
          Text("Save so you can restore this inbox.")
          Spacer()
          if account.busy && area == .device { ProgressView().controlSize(.small) }
          Button("Save this Mac to my account") { area = .device; Task { await account.adopt(tokens: tokens) } }
            .disabled(account.busy)
        }
      } else if !tokens.isEmpty {
        Label("Saved to your account", systemImage: "checkmark.circle")
      } else {
        Text("Nothing on this Mac to save yet.").foregroundStyle(.secondary)
      }
    } header: { Text("This Mac") } footer: { status(.device) }

    if let data = account.data, !data.inboxes.isEmpty {
      Section {
        ForEach(data.inboxes) { identity in inboxRow(identity, data: data) }
      } header: { Text("Your inboxes") } footer: {
        VStack(alignment: .leading, spacing: 6) {
          if data.inboxes.count > 1 { Text("Each inbox stays separate. Choose which one this Mac receives.") }
          status(.inboxes)
        }
      }
    }

    Section {
      Button("Manage account in browser") { openURL(account.server.appending(path: "/account")) }
      Button("Delete account", role: .destructive) { confirmDeletion = true }
        .disabled(account.busy)
    } footer: { status(.delete) }
  }

  private func inboxRow(_ identity: AccountIdentity, data: AccountData) -> some View {
    let here = inbox.accountCredential.flatMap(tokenInboxId) == identity.id
    let isDefault = data.defaultInboxId == identity.id
    return HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text("Taps for \(identity.name)")
        let tags = [here ? "Receiving here" : nil, isDefault ? "Default" : nil].compactMap { $0 }
        if !tags.isEmpty { Text(tags.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
      }
      Spacer()
      if restoring == identity.id { ProgressView().controlSize(.small) }
      Menu("Options") {
        Button("Receive here") { selectedInbox = identity }.disabled(here)
        Button("Make default") { area = .inboxes; Task { await account.setDefault(identity.id) } }.disabled(isDefault)
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
      .disabled(here && isDefault)
    }
  }

  @ViewBuilder private func status(_ section: Area) -> some View {
    if area == section {
      if let error = account.error {
        Text(error).foregroundStyle(.red)
      } else if let notice = account.notice {
        Text(notice).foregroundStyle(.secondary)
      }
    }
  }

  private func receive(_ identity: AccountIdentity) {
    area = .inboxes
    restoring = identity.id
    account.error = nil
    account.notice = nil
    Task {
      defer { restoring = nil }
      do {
        try await account.receiveInbox(id: identity.id, inbox: inbox, deviceName: Host.current().localizedName ?? "Mac", platform: "mac")
        account.notice = "This Mac now receives taps for \(identity.name)."
      } catch { account.error = error.localizedDescription }
    }
  }
}
