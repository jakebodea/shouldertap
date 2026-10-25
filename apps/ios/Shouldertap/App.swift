import ShouldertapCore
import SwiftUI

/// The stores, built on first use: by the app, or by a background launch
/// (a Lock Screen answer, a push) that never builds the UI.
@MainActor
enum Stores {
  static let senders: SenderStore = {
    let store = SenderStore(server: Config.server, persistence: KeychainPersistence())
    store.start()
    return store
  }()

  static let account = AccountStore(server: Config.server, vault: KeychainVault(service: "app.shouldertap.iphone.account"))

  static let inbox: ReceiverStore = {
    let inbox = ReceiverStore(
      endpoints: Endpoints(server: Config.server, web: Config.web),
      persistence: Config.inboxPersistence)
    // Someone accepted an invite, or a connection went away: new keys wait on the account.
    inbox.onCredentialsChanged = { Task { await Stores.sync() } }
    inbox.start()
    return inbox
  }()

  /// Brings this iPhone's inbox credential and sender keys in step with the
  /// account. Safe to call often: on launch, foreground, after signing in or
  /// saving the profile, and on the inbox's `credentials` event.
  static func sync() async {
    await account.sync(platform: .iphone, deviceName: UIDevice.current.name, inbox: inbox, senders: senders)
  }
}

@main
struct ShouldertapApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      RootView(account: Stores.account, store: Stores.senders, inbox: Stores.inbox)
        #if DEBUG && targetEnvironment(simulator)
          .task { await TapActivities.startMarketingCaptureIfRequested() }
        #endif
    }
  }
}

/// The two halves of the app.
enum HomeTab: String {
  /// People you tap.
  case tap
  /// Your own Shouldertap: taps for you, and who can send them.
  case inbox
}

/// Until you're signed in with a name and color, the first-run flow
/// (Onboarding.swift). After that the app is two tabs: Tap (the composer, or
/// adding your people) and Inbox. A tap waiting for you covers everything
/// while the app is open, like the Mac overlay.
struct RootView: View {
  let account: AccountStore
  let store: SenderStore
  let inbox: ReceiverStore
  @AppStorage("selectedPairing") private var selectedId = ""
  @AppStorage("homeTab") private var tab = HomeTab.tap
  /// Finished the first-run flow while signed in; cleared on sign-out.
  @AppStorage("onboarded") private var onboarded = false
  @State private var flowColor = PersonColor.cobalt
  /// An invite link opened before onboarding finished; accepted at its end.
  @State private var firstInvite = ""
  /// A sign-in QR link (shouldertap://qr#…) opened while signed out.
  @State private var signInLink = ""
  @State private var cover: RootCover?
  @State private var showAccount = false
  @State private var receiver = Receiver.shared
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackground = false

  var body: some View {
    ZStack {
      if showsOnboarding {
        Frame(color: flowColor) {
          OnboardingFlow(
            account: account, senders: store, invite: $firstInvite, signInLink: $signInLink, color: $flowColor,
            sync: Stores.sync
          ) { id in
            if let id {
              selectedId = id
              tab = .tap
            }
            withAnimation(.outExpo(0.6)) { onboarded = true }
          }
        }
        .transition(.opacity)
      } else {
        home.transition(.opacity)
      }
    }
    .sheet(isPresented: $showAccount) {
      NavigationStack {
        AccountView(account: account)
          .navigationTitle("Account")
          .toolbar { Button("Done") { showAccount = false } }
      }
      .sheetOnPaper()
    }
    .environment(\.inboxActions, actions)
    .environment(inbox)
    .fullScreenCover(item: $cover) { cover in
      Group {
        switch cover {
        case .invite(let text):
          AcceptInvite(account: account, senders: store, invite: text, onCancel: { self.cover = nil }) { id in
            if let id { selectedId = id }
            tab = .tap
            self.cover = nil
          }
        case .add:
          Frame(color: myColor) {
            AddPeople(
              inbox: inbox, senders: store, color: myColor, onInvite: { open(scanned: $0) },
              onClose: { self.cover = nil })
          }
        case .computer(let scanned):
          ComputerSignIn(account: account, color: myColor, scanned: scanned) { self.cover = nil }
        }
      }
      .environment(\.inboxActions, actions)
      .environment(inbox)
    }
    .alert(
      store.notice ?? "", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
    ) {
      Button("OK", role: .cancel) {}
    }
    .overlay { takeover }
    // shouldertap://join#<code> (or the web link) to connect with someone;
    // shouldertap://qr#<token> (or the web link) to sign in from a computer;
    // shouldertap://tap/<id> from a Live Activity.
    .onOpenURL { url in
      if receiver.handle(url) { return }
      if qrSignInToken(from: url.absoluteString) != nil {
        // Signed in already: this iPhone has its session; nothing to do.
        if account.signedIn {
          store.notice = "This iPhone is already signed in."
        } else {
          signInLink = url.absoluteString
        }
        return
      }
      guard inviteCode(from: url.absoluteString) != nil else { return }
      if showsOnboarding {
        firstInvite = url.absoluteString
      } else {
        cover = .invite(url.absoluteString)
      }
    }
    // Signed out or deleted: back to the start. Signed in without a profile
    // (made elsewhere and reset): back to the You step.
    .onChange(of: account.signedIn) { _, signedIn in
      if !signedIn {
        showAccount = false
        onboarded = false
      }
    }
    .onChange(of: account.me.map { $0.profile == nil }) { _, missing in
      if missing == true { onboarded = false }
    }
    .onChange(of: inbox.phase) { _, phase in
      if phase == .ready { receiver.sync() }
    }
    .onChange(of: inbox.credentialId) { _, _ in receiver.sync() }
    .onChange(of: inbox.taps) { _, taps in receiver.reconcile(taps) }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background: wasBackground = true
      case .active:
        receiver.sync()
        guard wasBackground else { break }
        wasBackground = false
        store.nudge()
        inbox.nudge()
        inbox.refresh()
        Task { await Stores.sync() }
      default: break
      }
    }
    .task {
      receiver.sync()
      await account.refresh()
      await Stores.sync()
    }
  }

  private var home: some View {
    TabView(selection: $tab) {
      tapHome
        .tabItem { Label("Tap", systemImage: "paperplane") }
        .tag(HomeTab.tap)
      inboxHome
        .tabItem { Label("Inbox", systemImage: "tray") }
        .tag(HomeTab.inbox)
        .badge(waiting)
    }
    .tint(Paper.ink)
  }

  @ViewBuilder private var tapHome: some View {
    if let session = composing {
      Frame(color: session.color) {
        ComposeView(
          session: session, store: store,
          onSelect: { id in withAnimation(.outExpo(0.5)) { selectedId = id } },
          onAdd: { cover = .add })
      }
    } else {
      Frame(color: myColor) {
        AddPeople(inbox: inbox, senders: store, color: myColor, onInvite: { open(scanned: $0) })
      }
    }
  }

  @ViewBuilder private var inboxHome: some View {
    if inbox.phase == .ready {
      Frame(color: inboxColor) {
        InboxScreen(inbox: inbox, senders: store)
      }
    } else {
      InboxWaiting(account: account, senders: store) { Task { await Stores.sync() } }
    }
  }

  @ViewBuilder private var takeover: some View {
    if scenePhase == .active, inbox.phase == .ready, let active = inbox.activeTap {
      TapTakeover(active: active, receiver: receiver)
        .transition(.opacity)
        // On this phone's screen now: tell the sender, as the Mac does.
        .task(id: active.tap.id) { inbox.didDisplay(tapId: active.tap.id) }
    }
  }

  /// Your own color, from the profile.
  private var myColor: PersonColor { account.me?.profile?.color ?? .cobalt }

  /// The person being tapped.
  private var composing: SenderSession? {
    store.session(id: selectedId) ?? store.sessions.last
  }

  private var showsOnboarding: Bool { !(account.signedIn && onboarded) }

  /// Taps waiting for an answer, for the Inbox tab's badge.
  private var waiting: Int {
    guard inbox.phase == .ready else { return 0 }
    return inbox.taps.filter { $0.state == .pending && inbox.pendingAcks[$0.id] == nil }.count
  }

  private var actions: InboxActions {
    InboxActions(
      open: { tab = .inbox },
      account: { showAccount = true })
  }

  /// A link pasted or scanned in Add your people: a computer's sign-in code
  /// asks to sign it in; anything else is an invite.
  private func open(scanned: String) {
    cover = deviceSignInCode(from: scanned) != nil ? .computer(scanned) : .invite(scanned)
  }
}

/// What covers the root: accepting an invite, adding someone, or signing a
/// computer in.
enum RootCover: Identifiable, Hashable {
  case invite(String)
  case add
  /// A computer's scanned sign-in link; nil scans for one.
  case computer(String?)

  var id: Self { self }
}
