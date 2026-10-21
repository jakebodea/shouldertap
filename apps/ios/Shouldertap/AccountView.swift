import SwiftUI
import ShouldertapCore
import StoreKit

/// Your email account: recovery for this iPhone's inbox and the people you
/// tap. Optional; messaging never needs it. Signing out keeps everything on
/// this iPhone.
struct AccountView: View {
  let account: AccountStore
  let inbox: ReceiverStore
  let senders: SenderStore
  @Environment(\.openURL) private var openURL
  @State private var usStorefront = false
  @State private var selectedInbox: AccountIdentity?
  @State private var confirmDeletion = false
  /// Which section the last result belongs to, so it shows beside its action.
  @State private var area = Area.top
  @State private var restoring: String?

  private enum Area { case top, device, inboxes, people, delete }

  var body: some View {
    Form {
      if let email = account.email {
        signedIn(email)
      } else if let code = account.authorization {
        codeCard(code)
      } else if account.isLoading {
        Section { HStack { Spacer(); ProgressView(); Spacer() } }
      } else {
        Section {
          Text("Restore your inbox and the people you tap on a new iPhone.")
          Button("Sign in with email") { area = .top; Task { await account.begin() } }
            .disabled(account.busy)
        } footer: { status(.top) }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Paper.paper)
    .task {
      await account.refresh()
      usStorefront = await Storefront.current?.countryCode == "USA"
      for await storefront in Storefront.updates {
        usStorefront = storefront.countryCode == "USA"
      }
    }
    .confirmationDialog("Receive taps from this inbox?", isPresented: Binding(
      get: { selectedInbox != nil }, set: { if !$0 { selectedInbox = nil } }
    ), titleVisibility: .visible) {
      if let identity = selectedInbox {
        Button("Receive from \(identity.name)") { restore(identity, kind: "inbox") }
      }
      Button("Cancel", role: .cancel) { selectedInbox = nil }
    } message: {
      Text("This iPhone will receive the selected inbox. Your current inbox stays separate and saved to your account, so you can switch back.")
    }
    .confirmationDialog("Delete your account?", isPresented: $confirmDeletion, titleVisibility: .visible) {
      Button("Delete account", role: .destructive) { area = .delete; Task { await account.deleteAccount() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Deletes your account and its recovery links. Your inbox and the people you tap stay on this iPhone. Cancel an active membership first. You may need to sign in again.")
    }
  }

  // MARK: Sections

  @ViewBuilder private func codeCard(_ code: DeviceAuthorization) -> some View {
    Section {
      Text(code.user_code)
        .font(.system(size: 36, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .tracking(4)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .accessibilityLabel("Code \(code.user_code.map(String.init).joined(separator: " "))")
      Button("Continue in browser") { openURL(code.verification_uri_complete) }
        .bold()
      Button("Cancel", role: .cancel) { account.cancel() }
    } header: {
      Text("Confirm this code in your browser")
    } footer: {
      VStack(alignment: .leading, spacing: 8) {
        Text("Sign in, check that the browser shows the same code, then come back. This updates on its own.")
        status(.top)
      }
    }
  }

  @ViewBuilder private func signedIn(_ email: String) -> some View {
    Section("Signed in as") {
      Text(email)
      Button("Sign out") { area = .top; Task { await account.signOut() } }
    }
    let tokens = localTokens
    Section {
      if account.hasUnsaved(inboxToken: inbox.accountCredential, senders: senders.sessions.map(\.pairing)) {
        Button {
          area = .device
          Task { await account.adopt(tokens: tokens) }
        } label: {
          HStack {
            Text("Save this iPhone to my account")
            if account.busy && area == .device { Spacer(); ProgressView() }
          }
        }
        .disabled(account.busy)
      } else if !tokens.isEmpty {
        Label("Saved to your account", systemImage: "checkmark.circle")
      } else {
        Text("Nothing on this iPhone to save yet.").foregroundStyle(.secondary)
      }
    } header: { Text("This iPhone") } footer: { status(.device) }

    if let data = account.data {
      if !data.inboxes.isEmpty {
        Section {
          ForEach(data.inboxes) { identity in inboxRow(identity, data: data) }
        } header: { Text("Your inboxes") } footer: {
          VStack(alignment: .leading, spacing: 8) {
            if data.inboxes.count > 1 { Text("Each inbox stays separate. Choose which one this iPhone receives.") }
            status(.inboxes)
          }
        }
      }
      if !data.senders.isEmpty {
        Section {
          ForEach(data.senders) { identity in personRow(identity) }
        } header: { Text("People you can tap") } footer: { status(.people) }
      }
      if usStorefront, !data.patrons.isEmpty || account.checkoutEnabled {
        // Purchases happen on the web; this only opens the account page.
        Section("Patron") {
          Link(data.patrons.isEmpty ? "Become a patron" : "Manage patron membership",
            destination: account.server.appending(path: "/account").appending(queryItems: [URLQueryItem(name: "section", value: "patron")]))
        }
      }
    }

    Section {
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
      if restoring == identity.id { ProgressView() }
      // One control per row: a Form row with two buttons fires both.
      Menu {
        Button("Receive here") { selectedInbox = identity }.disabled(here)
        Button("Make default") { area = .inboxes; Task { await account.setDefault(identity.id) } }.disabled(isDefault)
      } label: {
        Image(systemName: "ellipsis.circle").imageScale(.large)
      }
      .accessibilityLabel("Options for \(identity.name)")
      .disabled(here && isDefault)
    }
  }

  private func personRow(_ identity: AccountIdentity) -> some View {
    let local = senders.sessions.contains { $0.pairing.inboxId == identity.inboxId }
    return HStack {
      Text("Tap \(identity.name)")
      Spacer()
      if local {
        Text("On this iPhone").font(.subheadline).foregroundStyle(.secondary)
      } else if restoring == identity.id {
        ProgressView()
      } else {
        Button("Restore") { restore(identity, kind: "sender") }
          .buttonStyle(.borderless)
          .disabled(restoring != nil)
      }
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

  private var localTokens: [String] {
    [inbox.accountCredential].compactMap { $0 } + senders.sessions.map { $0.pairing.token }
  }

  private func restore(_ identity: AccountIdentity, kind: String) {
    area = kind == "inbox" ? .inboxes : .people
    restoring = identity.id
    account.error = nil
    account.notice = nil
    Task {
      defer { restoring = nil }
      do {
        if kind == "inbox" {
          try await account.receiveInbox(id: identity.id, inbox: inbox, deviceName: UIDevice.current.name, platform: "iphone")
          account.notice = "This iPhone now receives taps for \(identity.name)."
        } else {
          let grant = try await account.restore(kind: kind, id: identity.id, deviceName: UIDevice.current.name, platform: "iphone")
          try await senders.restoreAccountSender(grant)
          account.notice = "You can tap \(identity.name) again."
        }
      } catch { account.error = error.localizedDescription }
    }
  }
}

/// Account, on the frame's top edge: a quiet ink icon like Help.
struct AccountButton: View {
  @Environment(\.inboxActions) private var actions

  var body: some View {
    Button(action: actions.account) {
      Image(systemName: "person.crop.circle").font(.system(size: 19))
    }
    .buttonStyle(FrameButtonStyle(iconOnly: true))
    .accessibilityLabel("Account")
    .accessibilityIdentifier("account-button")
  }
}
