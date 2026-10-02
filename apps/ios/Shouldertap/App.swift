import ShouldertapCore
import SwiftUI

@main
struct ShouldertapApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var store: SenderStore
  @State private var inbox: ReceiverStore

  init() {
    let store = SenderStore(server: Config.server, persistence: KeychainPersistence())
    store.start()
    _store = State(initialValue: store)
    let inbox = ReceiverStore(
      endpoints: Endpoints(server: Config.server, web: Config.web),
      persistence: Config.inboxPersistence,
      deviceName: { UIDevice.current.name },
      platform: .iphone)
    inbox.start()
    _inbox = State(initialValue: inbox)
  }

  var body: some Scene {
    WindowGroup {
      RootView(store: store, inbox: inbox)
    }
  }
}

/// Which screen: the pairing flow until this phone has someone to tap (and
/// has seen the "paired" screen), then the composer for the selected person.
/// A phone linked to your own Mac with no one to tap yet shows your inbox
/// instead. They all sit in one frame, so its color floods from one to the
/// other. Invite links open the flow straight at name and color; the Mac's
/// link code opens linking.
struct RootView: View {
  let store: SenderStore
  let inbox: ReceiverStore
  @AppStorage("selectedPairing") private var selectedId = ""
  @State private var onboarding: Bool
  @State private var flowColor = PersonColor.cobalt
  @State private var firstInvite = ""
  @State private var cover: RootCover?
  /// This phone is unlinking itself, so the inbox going away isn't news.
  @State private var unlinking = false
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackground = false
  @State private var incoming = IncomingTaps.shared

  init(store: SenderStore, inbox: ReceiverStore) {
    self.store = store
    self.inbox = inbox
    _onboarding = State(initialValue: store.sessions.isEmpty)
  }

  var body: some View {
    Frame(color: composing?.color ?? (showsInbox ? inboxColor : flowColor)) {
      if let session = composing {
        ComposeView(
          session: session, store: store, inbox: inbox,
          onSelect: { id in withAnimation(.outExpo(0.5)) { selectedId = id } },
          onAdd: { cover = .invite("") },
          onInbox: { cover = .inbox }
        )
        .transition(.opacity)
      } else if showsInbox {
        InboxScreen(inbox: inbox, senders: store, onTapSomeone: { cover = .invite("") })
          .transition(.opacity)
      } else {
        PairFlow(store: store, invite: firstInvite, firstRun: true, color: $flowColor) { id in
          selectedId = id
          withAnimation(.outExpo(0.6)) { onboarding = false }
        }
        .id(firstInvite)
        .transition(.opacity)
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
            withAnimation(.outExpo(0.6)) { onboarding = false }
          }
        case .link(let code):
          LinkCover(inbox: inbox, code: code, onClose: { self.cover = nil }) {
            self.cover = nil
          }
        case .inbox:
          InboxCover(inbox: inbox, senders: store) { self.cover = nil }
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
    // An incoming tap covers everything, like the Mac overlay.
    .overlay {
      if let tap = incoming.current {
        TapTakeover(taps: incoming, tap: tap)
          .transition(.opacity)
      }
    }
    // shouldertap://join#<code> now; https://shouldertap.app/join#<code>
    // once universal links (apple-app-site-association) are set up. The
    // Mac's QR code for linking is shouldertap://link#<code>.
    .onOpenURL { url in
      if incoming.handle(url) { return }
      if url.host() == "link" {
        openLink(code: url.absoluteString)
        return
      }
      guard inviteCode(from: url.absoluteString) != nil else { return }
      if composing == nil && !showsInbox {
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
    // Unlinked from elsewhere (the Mac removed this iPhone): say so once.
    .onChange(of: inbox.phase) { old, new in
      guard old == .ready, new == .setup else { return }
      if cover == .inbox { cover = nil }
      if !unlinking { store.notice = "This iPhone was unlinked from your Shouldertap" }
      unlinking = false
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background: wasBackground = true
      case .active where wasBackground:
        wasBackground = false
        store.nudge()
        inbox.nudge()
      default: break
      }
    }
  }

  /// The person being tapped, once onboarding is done.
  private var composing: SenderSession? {
    guard !onboarding else { return nil }
    return store.session(id: selectedId) ?? store.sessions.last
  }

  /// No one to tap yet, but linked to your own Mac: your inbox is home.
  private var showsInbox: Bool {
    composing == nil && inbox.phase == .ready && firstInvite.isEmpty
  }

  private var actions: InboxActions {
    InboxActions(
      open: { cover = .inbox },
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

/// What covers the root: adding someone to tap, linking your Mac, or your
/// inbox over the composer.
enum RootCover: Identifiable, Hashable {
  case invite(String)
  case link(String)
  case inbox

  var id: Self { self }
}
