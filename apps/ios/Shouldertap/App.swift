import ShouldertapCore
import SwiftUI

/// The two stores, built on first use: by the app, or by a background launch
/// (a Lock Screen answer, a push) that never builds the UI.
@MainActor
enum Stores {
  static let senders: SenderStore = {
    let store = SenderStore(server: Config.server, persistence: KeychainPersistence())
    store.start()
    return store
  }()

  static let inbox: ReceiverStore = {
    let inbox = ReceiverStore(
      endpoints: Endpoints(server: Config.server, web: Config.web),
      persistence: Config.inboxPersistence,
      deviceName: { UIDevice.current.name },
      platform: .iphone)
    inbox.start()
    return inbox
  }()
}

@main
struct ShouldertapApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      RootView(store: Stores.senders, inbox: Stores.inbox)
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

/// A brand-new phone gets the welcome, which leads to tapping someone or to
/// linking your own Mac. After that the app is two tabs: Tap (the composer,
/// or getting an invite) and Inbox (your inbox, or linking it). A tap
/// waiting for you covers everything while the app is open, like the Mac
/// overlay.
struct RootView: View {
  let store: SenderStore
  let inbox: ReceiverStore
  @AppStorage("selectedPairing") private var selectedId = ""
  @AppStorage("homeTab") private var tab = HomeTab.tap
  /// Pairing to tap someone is in progress (or hasn't started): the flow
  /// shows until its last screen is done, not as soon as the pairing exists.
  @State private var onboarding: Bool
  @State private var flowColor = PersonColor.cobalt
  @State private var firstInvite = ""
  @State private var cover: RootCover?
  /// This phone is unlinking itself, so the inbox going away isn't news.
  @State private var unlinking = false
  @State private var receiver = Receiver.shared
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackground = false

  init(store: SenderStore, inbox: ReceiverStore) {
    self.store = store
    self.inbox = inbox
    _onboarding = State(initialValue: store.sessions.isEmpty)
  }

  var body: some View {
    ZStack {
      if showsWelcome {
        Frame(color: flowColor) {
          PairFlow(store: store, invite: firstInvite, firstRun: true, color: $flowColor) { id in
            selectedId = id
            withAnimation(.outExpo(0.6)) { onboarding = false }
          }
          .id(firstInvite)
        }
        .transition(.opacity)
      } else {
        home.transition(.opacity)
      }
    }
    .environment(\.inboxActions, actions)
    .environment(inbox)
    .fullScreenCover(item: $cover) { cover in
      Group {
        switch cover {
        case .invite(let text):
          PairCover(store: store, invite: text, onCancel: { self.cover = nil }) { id in
            selectedId = id
            self.cover = nil
            onboarding = false
          }
        case .link(let code):
          LinkCover(inbox: inbox, code: code, onClose: { self.cover = nil }) {
            self.cover = nil
          }
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
    // shouldertap://join#<code> to tap someone; shouldertap://link#<code>
    // from the Mac's QR code; shouldertap://tap/<id> from a Live Activity.
    .onOpenURL { url in
      if receiver.handle(url) { return }
      if url.host() == "link" {
        openLink(code: url.absoluteString)
        return
      }
      guard inviteCode(from: url.absoluteString) != nil else { return }
      if showsWelcome {
        firstInvite = url.absoluteString
      } else {
        cover = .invite(url.absoluteString)
      }
    }
    .onChange(of: store.sessions.isEmpty) { _, empty in
      guard empty else { return }
      firstInvite = ""
      withAnimation(.outExpo(0.6)) { onboarding = true }
    }
    .onChange(of: inbox.phase) { old, new in
      if new == .ready {
        receiver.sync()
        withAnimation(.outExpo(0.5)) { tab = .inbox }
      }
      // Unlinked from elsewhere (the Mac removed this iPhone): say so once.
      guard old == .ready, new == .setup else { return }
      if !unlinking { store.notice = "This iPhone was unlinked from your Shouldertap" }
      unlinking = false
    }
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
      default: break
      }
    }
    .task { receiver.sync() }
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
    if !onboarding, let session = composing {
      Frame(color: session.color) {
        ComposeView(
          session: session, store: store,
          onSelect: { id in withAnimation(.outExpo(0.5)) { selectedId = id } },
          onAdd: { cover = .invite("") })
      }
    } else {
      Frame(color: flowColor) {
        PairFlow(store: store, firstRun: false, color: $flowColor) { id in
          selectedId = id
          withAnimation(.outExpo(0.6)) { onboarding = false }
        }
      }
    }
  }

  @ViewBuilder private var inboxHome: some View {
    if inbox.phase == .ready {
      Frame(color: inboxColor) {
        InboxScreen(inbox: inbox, senders: store)
      }
    } else {
      LinkCover(inbox: inbox, onLinked: {})
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

  /// The person being tapped.
  private var composing: SenderSession? {
    store.session(id: selectedId) ?? store.sessions.last
  }

  /// Nothing set up yet: the first-run flow, full screen.
  private var showsWelcome: Bool {
    onboarding && inbox.phase != .ready
  }

  /// Taps waiting for an answer, for the Inbox tab's badge.
  private var waiting: Int {
    guard inbox.phase == .ready else { return 0 }
    return inbox.taps.filter { $0.state == .pending && inbox.pendingAcks[$0.id] == nil }.count
  }

  private var actions: InboxActions {
    InboxActions(
      open: { tab = .inbox },
      link: { openLink(code: "") },
      unlinking: { unlinking = true })
  }

  private func openLink(code: String) {
    if inbox.phase == .ready {
      store.notice = "This iPhone is already linked to your Shouldertap. To link another inbox, unlink it first."
    } else {
      cover = .link(code)
    }
  }
}

/// What covers the root: adding someone to tap, or linking your Mac.
enum RootCover: Identifiable, Hashable {
  case invite(String)
  case link(String)

  var id: Self { self }
}
