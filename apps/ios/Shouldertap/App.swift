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

/// Which screen: pairing until there is a recipient, then the composer for
/// the selected recipient. Invite links open the pairing sheet.
struct RootView: View {
  let store: SenderStore
  @AppStorage("selectedPairing") private var selectedId = ""
  @State private var invite: InviteRequest?
  @State private var firstInvite = ""
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackground = false

  var body: some View {
    Group {
      if let session = selected {
        ComposeView(
          session: session, store: store,
          onSelect: { selectedId = $0 },
          onAdd: { invite = InviteRequest(text: "") })
          .id(session.id)
      } else {
        PairView(store: store, invite: firstInvite) { selectedId = $0.id }
          .id(firstInvite)
      }
    }
    .sheet(item: $invite) { request in
      PairView(store: store, invite: request.text, isSheet: true) { session in
        selectedId = session.id
        invite = nil
      }
    }
    .alert(
      store.notice ?? "", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
    ) {
      Button("OK", role: .cancel) {}
    }
    // shouldertap://join#<code> now; https://shouldertap.app/join#<code>
    // once universal links (apple-app-site-association) are set up.
    .onOpenURL { url in
      guard inviteCode(from: url.absoluteString) != nil else { return }
      if store.sessions.isEmpty {
        firstInvite = url.absoluteString
      } else {
        invite = InviteRequest(text: url.absoluteString)
      }
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

  private var selected: SenderSession? {
    store.session(id: selectedId) ?? store.sessions.last
  }
}

struct InviteRequest: Identifiable {
  let id = UUID()
  var text: String
}
