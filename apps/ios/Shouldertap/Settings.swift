import ShouldertapCore
import SwiftUI

// Settings: one sheet, from the person icon on every frame bar
// (docs/design.md, "Sender (iOS app)"). You, the people you tap and who can
// tap you, your devices, notifications, patron support, help and the account.

/// A page inside Settings, so it can open straight there (long-press someone
/// in the composer for theirs).
enum SettingsPage: Hashable {
  case you
  /// Someone you tap, by session id.
  case person(String)
  case devices
  case help
  case account
}

/// Settings, on the frame's top edge: the only icon there.
struct SettingsButton: View {
  @Environment(\.inboxActions) private var actions

  var body: some View {
    Button { actions.settings(nil) } label: {
      Image(systemName: "person.crop.circle").font(.system(size: 19))
    }
    .buttonStyle(FrameButtonStyle(iconOnly: true))
    .accessibilityLabel("Settings")
    .accessibilityIdentifier("settings-button")
  }
}

struct SettingsView: View {
  let account: AccountStore
  let senders: SenderStore
  let inbox: ReceiverStore
  @Binding var path: [SettingsPage]
  /// Add someone: closes Settings for the add cover.
  let onAdd: () -> Void

  @State private var removing: Credential?
  @State private var openingPatron = false
  @State private var patronError: String?
  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss

  private var me: Profile? { account.me?.profile }
  private var canTapYou: [Credential] { inbox.credentials.filter { $0.kind == .sender } }

  var body: some View {
    NavigationStack(path: $path) {
      Form {
        Section {
          NavigationLink(value: SettingsPage.you) {
            HStack(spacing: 12) {
              Avatar(name: me?.name ?? "", color: me?.color ?? .cobalt, size: 44)
              VStack(alignment: .leading, spacing: 2) {
                Text(me?.name ?? "You").font(Bricolage.bold(17))
                Text("Name, color, replies").font(Bricolage.medium(14)).foregroundStyle(Paper.tone)
              }
            }
          }
          .accessibilityIdentifier("settings-you")
        }
        Section("You tap") {
          ForEach(senders.sessions) { person in
            NavigationLink(value: SettingsPage.person(person.id)) {
              HStack(spacing: 12) {
                Avatar(name: person.pairing.recipientName, color: person.color, size: 32)
                Text(person.pairing.recipientName)
              }
            }
            .accessibilityIdentifier("settings-person-\(person.pairing.recipientName)")
          }
          Button(action: onAdd) {
            Label { Text("Add someone") } icon: { IconView(icon: .invite, size: 20) }
          }
          .accessibilityIdentifier("settings-add")
        }
        Section {
          if canTapYou.isEmpty {
            Text("No one yet.").foregroundStyle(Paper.tone)
          }
          ForEach(canTapYou) { credential in
            CredentialRow(credential: credential, isSelf: false) { removing = credential }
          }
        } header: {
          Text("Can tap you")
        } footer: {
          Text("Removing someone you tap doesn't stop them tapping you; remove them here too.")
        }
        Section {
          NavigationLink(value: SettingsPage.devices) {
            LabeledContent {
              Text("\(inbox.credentials.filter { $0.kind == .device }.count)")
            } label: {
              Label("Devices", systemImage: "laptopcomputer.and.iphone")
            }
          }
          .accessibilityIdentifier("settings-devices")
          notifications
          if USStorefront.shared.isUS, Stores.patron.checkoutEnabled {
            // Purchases happen on the web; this only opens the account page,
            // signed in to this account.
            Button { Task { await openPatronPage() } } label: {
              LabeledContent {
                if Stores.patron.active { Text("Patron") }
              } label: {
                Label("Support Shouldertap", systemImage: "heart")
              }
            }
            .disabled(openingPatron)
          }
        } footer: {
          if let patronError { Text(patronError).foregroundStyle(.red) }
        }
        Section {
          NavigationLink(value: SettingsPage.help) {
            Label("Help and privacy", systemImage: "questionmark.circle")
          }
          NavigationLink(value: SettingsPage.account) {
            LabeledContent {
              Text(account.email ?? "").lineLimit(1)
            } label: {
              Label("Account", systemImage: "at")
            }
          }
          .accessibilityIdentifier("settings-account")
        }
      }
      .settingsPage("Settings", close: close)
      .navigationDestination(for: SettingsPage.self) { page in
        destination(page)
      }
    }
    .tint(Paper.ink)
    .sheetOnPaper()
    .removingCredential($removing, from: inbox)
    .task {
      await account.refresh()
      await Stores.patron.refresh()
    }
  }

  /// On or off; opens the system's settings for this app (or asks, the first time).
  private var notifications: some View {
    Button {
      if Receiver.shared.notificationsAllowed == nil {
        Task { await Receiver.shared.requestNotifications() }
      } else if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
        UIApplication.shared.open(url)
      }
    } label: {
      LabeledContent {
        Text(Receiver.shared.notificationsAllowed == true ? "On" : "Off")
      } label: {
        Label("Notifications", systemImage: "bell")
      }
    }
    .accessibilityIdentifier("settings-notifications")
  }

  private func close() { dismiss() }

  @ViewBuilder private func destination(_ page: SettingsPage) -> some View {
    switch page {
    case .you:
      YouPage(account: account).settingsPage("You", close: close)
    case .person(let id):
      if let person = senders.session(id: id) {
        PersonPage(person: person, account: account, senders: senders) {
          path.removeAll { $0 == page }
        }
        .settingsPage(person.pairing.recipientName, close: close)
      }
    case .devices:
      DevicesPage(account: account, inbox: inbox).settingsPage("Devices", close: close)
    case .help:
      HelpPage().settingsPage("Help and privacy", close: close)
    case .account:
      AccountPage(account: account, inbox: inbox).settingsPage("Account", close: close)
    }
  }

  private func openPatronPage() async {
    openingPatron = true
    patronError = nil
    defer { openingPatron = false }
    do { openURL(try await patronPage(account: account)) } catch { patronError = error.localizedDescription }
  }
}

extension View {
  /// A page of Settings: on paper, titled, with Done closing the sheet
  /// (inside the stack, `dismiss` would only go back a page).
  fileprivate func settingsPage(_ title: String, close: @escaping () -> Void) -> some View {
    modifier(SettingsPageChrome(title: title, close: close))
  }

  /// Asks before revoking someone who can tap you, or one of your devices.
  func removingCredential(_ credential: Binding<Credential?>, from inbox: ReceiverStore) -> some View {
    modifier(CredentialRemoval(inbox: inbox, removing: credential))
  }
}

private struct SettingsPageChrome: ViewModifier {
  let title: String
  let close: () -> Void

  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background(Paper.paper)
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(title == "Settings" ? .large : .inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", action: close).accessibilityIdentifier("settings-done")
        }
      }
  }
}

private struct CredentialRemoval: ViewModifier {
  let inbox: ReceiverStore
  @Binding var removing: Credential?
  @State private var error: String?

  func body(content: Content) -> some View {
    content
      .confirmationDialog(
        removing.map { "Remove \($0.name)?" } ?? "",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
        titleVisibility: .visible,
        presenting: removing
      ) { credential in
        Button("Remove", role: .destructive) { remove(credential) }
      } message: { credential in
        Text(
          credential.kind == .sender
            ? "Their taps stop reaching you. To tap you again, they'll need a new invite."
            : "Taps stop reaching it until you sign in on it again.")
      }
      .alert("Couldn't remove it", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(error ?? "")
      }
  }

  private func remove(_ credential: Credential) {
    Task {
      do {
        try await inbox.revoke(credentialId: credential.id)
      } catch {
        self.error = (error as? APIError)?.message ?? error.localizedDescription
      }
    }
  }
}

// MARK: You

/// Your own name and color, for everyone you connect with from now on, and
/// the two answers every tap offers.
private struct YouPage: View {
  let account: AccountStore
  @State private var name: String
  @State private var color: PersonColor
  /// Reply options typed but not saved; nil shows what the account has.
  @State private var replies: [String]?
  @FocusState private var nameFocused: Bool

  init(account: AccountStore) {
    self.account = account
    _name = State(initialValue: account.me?.profile?.name ?? "")
    _color = State(initialValue: account.me?.profile?.color ?? .cobalt)
  }

  private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var changed: Bool { account.me?.profile != Profile(name: trimmedName, color: color) }
  private var savedReplies: [String] { account.me?.defaultReplies ?? defaultQuickReplies }

  var body: some View {
    Form {
      Section("Your name") {
        TextField("e.g. Sam", text: $name)
          .textContentType(.givenName)
          .submitLabel(.done)
          .focused($nameFocused)
          .onChange(of: name) { _, value in
            if value.count > maxNameLength { name = String(value.prefix(maxNameLength)) }
          }
          .accessibilityIdentifier("you-name")
      }
      Section {
        ColorGrid(color: $color).padding(.vertical, 8)
      } header: {
        Text("Your color")
      }
      Section {
        TapPreview(name: trimmedName.isEmpty ? "You" : trimmedName, color: color, message: "Got a minute?")
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
        if changed {
          Button {
            nameFocused = false
            Task { await account.saveProfile(name: trimmedName, color: color) }
          } label: {
            if account.busy { ProgressView().tint(color.ink) } else { Text("Save") }
          }
          .buttonStyle(PillStyle(color: color))
          .disabled(trimmedName.isEmpty || account.busy)
          .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 0, trailing: 0))
          .listRowBackground(Color.clear)
          .accessibilityIdentifier("you-save")
        }
      } footer: {
        if let error = account.error {
          Text(error).foregroundStyle(.red)
        } else {
          Text("People you connect with from now on see you this way. Everyone you tap already keeps how they see you; change that on their page.")
        }
      }
      replyOptions
    }
  }

  /// The two answers every tap offers unless changed on it.
  @ViewBuilder private var replyOptions: some View {
    let shown = replies ?? savedReplies
    Section {
      ForEach(0..<2, id: \.self) { index in
        LabeledContent("\(index + 1)") {
          TextField(
            "Reply \(index + 1)",
            text: Binding(
              get: { shown.indices.contains(index) ? shown[index] : "" },
              set: { value in
                var next = shown
                next[index] = String(value.prefix(maxQuickReplyLength))
                replies = next
              })
          )
          .accessibilityLabel("Reply option \(index + 1)")
        }
      }
      if let chosen = tidyQuickReplies(shown), chosen != savedReplies {
        Button("Save replies") { Task { if await account.saveQuickReplies(chosen) { replies = nil } } }
          .disabled(account.busy)
      } else if replies == nil, savedReplies != defaultQuickReplies {
        Button("Use On it and In 10 min") { Task { await account.saveQuickReplies(defaultQuickReplies) } }
          .disabled(account.busy)
      }
    } header: {
      Text("Reply options")
    } footer: {
      if case .failure(let problem) = normalizeQuickReplies(shown) {
        Text(problem.localizedDescription).foregroundStyle(.red)
      } else {
        Text("The two answers people get on your taps. You can still change them on a tap before you send it.")
      }
    }
  }
}

// MARK: Someone you tap

/// Someone you tap: how they see you (name, color, tap style), and removing
/// them, which also deletes the taps you sent them.
private struct PersonPage: View {
  let person: SenderSession
  let account: AccountStore
  let senders: SenderStore
  let onRemoved: () -> Void

  @State private var editing = false
  @State private var confirmRemove = false
  @State private var removing = false
  @State private var error: String?

  private var recipient: String { person.pairing.recipientName }
  /// What taps to them go in from here.
  private var theme: TapTheme { Stores.patron.theme(for: person.pairing) }

  var body: some View {
    Form {
      Section {
        VStack(spacing: 8) {
          Avatar(name: recipient, color: person.color, size: 64)
          Text(recipient).font(Bricolage.extraBold(26)).tracking(-0.8)
        }
        .frame(maxWidth: .infinity)
        .listRowBackground(Color.clear)
      }
      Section {
        SeenAsPreview(theme: theme, name: person.pairing.senderName, color: person.color)
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
      } header: {
        Text("How \(recipient) sees you")
      }
      Section {
        Button { editing = true } label: {
          LabeledContent("Name", value: person.pairing.senderName)
        }
        .accessibilityIdentifier("person-name")
        Button { editing = true } label: {
          LabeledContent("Color") {
            HStack(spacing: 6) {
              Circle().fill(person.color.base).frame(width: 12, height: 12)
              Text(person.color.label)
            }
          }
        }
        Button { editing = true } label: {
          LabeledContent("Tap style", value: theme.label)
        }
        .accessibilityIdentifier("person-style")
      } footer: {
        Text("Only \(recipient) sees this.")
      }
      Section {
        Button("Remove \(recipient)", role: .destructive) { confirmRemove = true }
          .foregroundStyle(.red)
          .disabled(removing)
          .accessibilityIdentifier("person-remove")
      } footer: {
        if let error { Text(error).foregroundStyle(.red) }
      }
    }
    .sheet(isPresented: $editing) {
      SeenAsEditor(
        title: "How \(recipient) sees you",
        note: "Only \(recipient) sees this. A new name or color changes your taps they already have too.",
        saveLabel: "Save", initial: Profile(name: person.pairing.senderName, color: person.color), theme: theme,
        onCancel: { editing = false },
        onSave: { profile, chosen in
          try await account.updateSendProfile(
            person.id, name: profile.name, color: profile.color, theme: chosen == theme ? nil : chosen,
            senders: senders)
          editing = false
        })
    }
    .confirmationDialog("Remove \(recipient)?", isPresented: $confirmRemove, titleVisibility: .visible) {
      Button("Remove \(recipient)", role: .destructive, action: remove)
    } message: {
      Text(
        "Your taps stop reaching \(recipient) on all your devices, and the taps you sent them are deleted. \(recipient) can still tap you. To tap them again, you'll need a new invite. Recovery copies may remain for up to 30 days."
      )
    }
  }

  /// Ends the connection on the account (so another sync doesn't bring it
  /// back) and deletes your taps to them.
  private func remove() {
    removing = true
    error = nil
    Task {
      defer { removing = false }
      do {
        try await account.remove(person.id, deleteData: true, senders: senders)
        onRemoved()
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}

// MARK: Devices

/// Where your taps arrive: this iPhone and your computers, and signing a
/// computer in.
private struct DevicesPage: View {
  let account: AccountStore
  let inbox: ReceiverStore
  @State private var removing: Credential?
  @State private var signingIn = false

  var body: some View {
    Form {
      Section {
        if inbox.phase != .ready {
          Text("Setting up your inbox…").foregroundStyle(Paper.tone)
        }
        ForEach(inbox.credentials.filter { $0.kind == .device }) { credential in
          CredentialRow(credential: credential, isSelf: credential.id == inbox.credentialId) { removing = credential }
        }
      } header: {
        Text("Getting your taps")
      } footer: {
        Text("Sign in on another iPhone, Mac or PC to get your taps there too.")
      }
      Section {
        Button {
          signingIn = true
        } label: {
          Label("Sign in on a computer", systemImage: "qrcode.viewfinder")
        }
        .accessibilityIdentifier("sign-in-computer")
      } footer: {
        Text("On your Mac, PC or browser, choose “Sign in with your phone” and scan the code it shows.")
      }
    }
    .removingCredential($removing, from: inbox)
    .fullScreenCover(isPresented: $signingIn) {
      ComputerSignIn(account: account, color: account.me?.profile?.color ?? .cobalt) { signingIn = false }
    }
  }
}

// MARK: Account

/// Who you're signed in as, signing out, and deleting the account. Signing
/// out keeps this iPhone's connections; the app asks you to sign in again
/// before going on.
private struct AccountPage: View {
  let account: AccountStore
  let inbox: ReceiverStore
  @State private var confirmDeletion = false

  var body: some View {
    Form {
      Section("Signed in as") {
        Text(account.email ?? "Your account")
          .accessibilityIdentifier("account-email")
        Button("Sign out") { Task { await account.signOut() } }
          .accessibilityIdentifier("sign-out")
      }
      // Support bought for this inbox before patron support moved to senders.
      if let patron = inbox.patron, patron.active {
        Section("Support Shouldertap") {
          Text(patron.status == "ending" ? "Thank you. Your support ends after the paid period." : "Thank you for your support.")
          if let until = patron.paidUntil {
            Text("Paid through \(Date(timeIntervalSince1970: until / 1000).formatted(date: .abbreviated, time: .omitted))")
              .foregroundStyle(Paper.tone)
          }
        }
      }
      Section {
        Button("Delete account", role: .destructive) { confirmDeletion = true }
          .foregroundStyle(.red)
          .disabled(account.busy)
      } footer: {
        if let error = account.error { Text(error).foregroundStyle(.red) }
      }
    }
    .confirmationDialog("Delete your account?", isPresented: $confirmDeletion, titleVisibility: .visible) {
      Button("Delete account", role: .destructive) { Task { await account.deleteAccount() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Deletes your account. The people you tap and your inbox stay on this iPhone until you remove them. Cancel an active membership first.")
    }
  }
}
