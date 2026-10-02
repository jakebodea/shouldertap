import ShouldertapCore
import SwiftUI

@main
struct ShouldertapApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var store: SenderStore

  init() {
    let store = SenderStore(server: Config.server, persistence: KeychainPersistence())
    store.start()
    _store = State(initialValue: store)
  }

  var body: some Scene {
    WindowGroup {
      RootView(store: store)
    }
  }
}

/// Which screen: the pairing flow until this phone has someone to tap (and
/// has seen the "paired" screen), then the composer for the selected person.
/// Both sit in one frame, so its color floods from one to the other. Invite
/// links open the flow straight at name and color.
struct RootView: View {
  let store: SenderStore
  @AppStorage("selectedPairing") private var selectedId = ""
  @State private var onboarding: Bool
  @State private var flowColor = PersonColor.cobalt
  @State private var firstInvite = ""
  @State private var invite: InviteRequest?
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackground = false
  @State private var incoming = IncomingTaps.shared

  init(store: SenderStore) {
    self.store = store
    _onboarding = State(initialValue: store.sessions.isEmpty)
  }

  var body: some View {
    Frame(color: composing?.color ?? flowColor) {
      if let session = composing {
        ComposeView(
          session: session, store: store,
          onSelect: { id in withAnimation(.outExpo(0.5)) { selectedId = id } },
          onAdd: { invite = InviteRequest(text: "") }
        )
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
    .fullScreenCover(item: $invite) { request in
      PairCover(store: store, invite: request.text, onCancel: { invite = nil }) { id in
        selectedId = id
        invite = nil
      }
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
    // once universal links (apple-app-site-association) are set up.
    .onOpenURL { url in
      if incoming.handle(url) { return }
      guard inviteCode(from: url.absoluteString) != nil else { return }
      if composing == nil {
        firstInvite = url.absoluteString
      } else {
        invite = InviteRequest(text: url.absoluteString)
      }
    }
    .onChange(of: store.sessions.isEmpty) { _, empty in
      guard empty else { return }
      firstInvite = ""
      withAnimation(.outExpo(0.6)) { onboarding = true }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background: wasBackground = true
      case .active where wasBackground:
        wasBackground = false
        store.nudge()
      default: break
      }
    }
  }

  /// The person being tapped, once onboarding is done.
  private var composing: SenderSession? {
    guard !onboarding else { return nil }
    return store.session(id: selectedId) ?? store.sessions.last
  }
}

struct InviteRequest: Identifiable {
  let id = UUID()
  var text: String
}
