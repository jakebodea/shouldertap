import Foundation
import Observation

/// Where the Mac keeps what must survive a restart.
public protocol ReceiverPersistence: Sendable {
  func loadCredential() -> String?
  func saveCredential(_ token: String) throws
  func deleteCredential()
  func loadPendingAcks() -> [String: TapResponse]
  func savePendingAcks(_ acks: [String: TapResponse])
}

public struct Endpoints: Sendable {
  public var server: URL
  public var web: URL

  public init(server: URL, web: URL) {
    self.server = server
    self.web = web
  }
}

/// The tap the overlay shows: the oldest one still waiting.
public struct ActiveTap: Equatable, Sendable {
  public var tap: Tap
  /// Other taps waiting behind this one.
  public var queued: Int

  public init(tap: Tap, queued: Int) {
    self.tap = tap
    self.queued = queued
  }
}

public struct SenderInvite: Sendable {
  public var url: URL
  public var expiresAt: Timestamp
}

/// All Mac client behavior in one place: the device credential, the live
/// connection, which tap the overlay shows, and acknowledgements that must
/// survive being offline. The UI only draws what this decides. The iPhone
/// uses it too, to receive and manage the inbox. Credentials come from the
/// account (`AccountStore.sync`).
@MainActor @Observable
public final class ReceiverStore {
  public enum Phase: Sendable { case loading, setup, ready }

  public private(set) var phase: Phase = .loading
  public private(set) var recipientName = ""
  public private(set) var credentialId: String?
  public private(set) var credentials: [Credential] = []
  /// Trial, paid or expired; nil until the first snapshot, or from a server
  /// older than payments.
  public private(set) var plan: Plan?
  /// A historical receiver-owned support subscription, if any (manage only).
  public private(set) var patron: Patron?
  /// The recipient's free settings: motion, plus legacy wire fields.
  /// `.standard` until the first snapshot, and from older servers.
  public private(set) var appearance: Appearance = .standard
  /// False for servers older than themes: there is nothing to change yet.
  public private(set) var appearanceSupported = false
  public private(set) var taps: [Tap] = []
  public private(set) var status: LiveStatus = .connecting
  /// Responses given on this Mac that the server hasn't confirmed yet.
  public private(set) var pendingAcks: [String: TapResponse] = [:]

  @ObservationIgnored private let endpoints: Endpoints
  @ObservationIgnored private let persistence: any ReceiverPersistence
  /// The inbox socket said connections changed: run `AccountStore.sync`.
  @ObservationIgnored public var onCredentialsChanged: (@MainActor () -> Void)?
  @ObservationIgnored private var api: APIClient
  @ObservationIgnored private var live: LiveConnection?
  @ObservationIgnored private var ackRetry: Task<Void, Never>?
  @ObservationIgnored private var reportedDisplayed: Set<String> = []
  @ObservationIgnored private let session: URLSession
  @ObservationIgnored private let ackRetryDelay: Duration

  public init(
    endpoints: Endpoints,
    persistence: any ReceiverPersistence,
    session: URLSession = .shared,
    ackRetryDelay: Duration = .seconds(10)
  ) {
    self.endpoints = endpoints
    self.persistence = persistence
    self.session = session
    self.ackRetryDelay = ackRetryDelay
    api = APIClient(baseURL: endpoints.server, session: session)
  }

  /// Loads saved state and connects. Returns false when this Mac still needs
  /// setting up, so the app can open the menu.
  @discardableResult
  public func start() -> Bool {
    pendingAcks = persistence.loadPendingAcks()
    guard let token = persistence.loadCredential() else {
      phase = .setup
      return false
    }
    connect(token)
    return true
  }

  /// Reconnect after sleep or a network change.
  public func nudge() {
    live?.nudge()
  }

  /// Refetch the snapshot (one GET) when the menu opens, so the plan is
  /// current after a checkout even if the live event was missed.
  public func refresh() {
    guard phase == .ready, api.token != nil else { return }
    resync()
  }

  // MARK: Plan

  /// The billing portal for a historical receiver-owned support subscription,
  /// so it can be canceled. Recipients can't start one: support belongs to
  /// senders now.
  public func managePatronURL() async throws -> URL {
    let checkout = try await api.managePatron()
    let url = checkout.url
    guard url.scheme == "https" else { throw APIError(code: .invalidRequest, message: "Invalid billing URL", status: 0) }
    return url
  }

  // MARK: Appearance

  /// Saves a change for every computer on the inbox. Free; anyone's devices.
  public func updateAppearance(
    motion: MotionPreference? = nil, senderThemes: SenderThemePreference? = nil
  ) async throws {
    appearance = try await api.updateAppearance(motion: motion, senderThemes: senderThemes)
    appearanceSupported = true
  }

  /// The theme to draw a tap in: its sender's style.
  public func theme(for tap: Tap) -> TapTheme {
    appearance.theme(for: tap)
  }

  // MARK: Overlay

  public var activeTap: ActiveTap? {
    guard phase == .ready else { return nil }
    let waiting = taps
      .filter { $0.state == .pending && pendingAcks[$0.id] == nil }
      .sorted { $0.createdAt < $1.createdAt }
    return waiting.first.map { ActiveTap(tap: $0, queued: waiting.count - 1) }
  }

  /// The overlay put this tap on screen; tell the sender once.
  public func didDisplay(tapId: String) {
    guard let tap = taps.first(where: { $0.id == tapId }), tap.displayedAt == nil,
      reportedDisplayed.insert(tapId).inserted
    else { return }
    let api = api
    Task {
      do {
        let displayed = try await api.markDisplayed(tapId: tapId)
        guard self.api.token == api.token else { return }
        merge(displayed)
      } catch {
        reportedDisplayed.remove(tapId)
      }
    }
  }

  // MARK: Credentials from the account

  public var accountCredential: String? { persistence.loadCredential() }

  /// Receive with a device credential the account issued (`/account/sync`).
  /// Replaces any credential this device held; refused while replies to the
  /// current inbox are still waiting to send.
  public func receive(_ grant: CredentialGrant) throws {
    guard grant.kind == .device else {
      throw APIError(code: .conflict, message: "An inbox requires a receiver credential.", status: 409)
    }
    guard grant.token != persistence.loadCredential() else { return }
    guard pendingAcks.isEmpty else {
      throw APIError(code: .conflict, message: "Wait for your pending replies to send before switching inboxes.", status: 409)
    }
    try persistence.saveCredential(grant.token)
    ackRetry?.cancel()
    recipientName = ""
    credentialId = nil
    credentials = []
    plan = nil
    patron = nil
    taps = []
    reportedDisplayed = []
    appearance = .standard
    appearanceSupported = false
    connect(grant.token)
  }

  /// The account says this device's inbox connection is gone (`removed`).
  public func drop(tokens: Set<String>) {
    guard let current = persistence.loadCredential(), tokens.contains(current) else { return }
    forget()
  }

  // MARK: Connection

  private func connect(_ token: String) {
    live?.close()
    api = api.withToken(token)
    phase = .ready
    status = .connecting
    let live = LiveConnection(
      api: api,
      handlers: .init(
        onResync: { [weak self] in self?.resync() },
        onTap: { [weak self] tap in guard self?.api.token == token else { return }; self?.merge(tap) },
        onTapDeleted: { [weak self] tapId in guard self?.api.token == token else { return }; self?.drop(tapId) },
        onStatus: { [weak self] status in guard self?.api.token == token else { return }; self?.status = status },
        onRevoked: { [weak self] in guard self?.api.token == token else { return }; self?.forget() },
        onCredentials: { [weak self] in guard self?.api.token == token else { return }; self?.onCredentialsChanged?() }
      ), session: session)
    self.live = live
    live.start()
  }

  private func resync() {
    let api = api
    Task {
      do {
        guard case let .receiver(snapshot) = try await api.me(), self.api.token == api.token else { return }
        recipientName = snapshot.recipientName
        credentialId = snapshot.credentialId
        credentials = snapshot.credentials
        plan = snapshot.plan
        patron = snapshot.patron
        appearance = snapshot.appearance ?? .standard
        appearanceSupported = snapshot.appearance != nil
        taps = mergeSnapshot(local: taps, snapshot: snapshot.taps)
      } catch let error as APIError where error.code == .unauthorized {
        guard self.api.token == api.token else { return }
        forget()
        return
      } catch {}
      flushAcks()
    }
  }

  private func merge(_ tap: Tap) {
    taps = mergeTap(taps, tap)
  }

  private func drop(_ tapId: String) {
    taps.removeAll { $0.id == tapId }
    dropPendingAck(tapId)
  }

  /// Unpaired (revoked, or this Mac removed itself): back to setup.
  private func forget() {
    live?.close()
    live = nil
    ackRetry?.cancel()
    persistence.deleteCredential()
    api = api.withToken(nil)
    setPendingAcks([:])
    recipientName = ""
    credentialId = nil
    credentials = []
    plan = nil
    patron = nil
    appearance = .standard
    appearanceSupported = false
    taps = []
    status = .offline
    phase = .setup
  }

  // MARK: Responding

  /// Dismiss locally right away; the sender sees it once the server commits,
  /// retried until it does, even across restarts.
  public func respond(tapId: String, response: TapResponse) {
    var acks = pendingAcks
    acks[tapId] = response
    setPendingAcks(acks)
    flushAcks()
  }

  /// `respond`, then wait for this attempt to reach the server: for answers
  /// given outside the app (the Lock Screen, a notification), which may
  /// only have a few seconds to run. A failed attempt stays queued.
  public func answer(tapId: String, response: TapResponse) async {
    respond(tapId: tapId, response: response)
    await ackRetry?.value
  }

  private func setPendingAcks(_ acks: [String: TapResponse]) {
    pendingAcks = acks
    persistence.savePendingAcks(acks)
  }

  private func flushAcks() {
    ackRetry?.cancel()
    ackRetry = nil
    guard api.token != nil, !pendingAcks.isEmpty else { return }
    let acks = pendingAcks
    let api = api
    ackRetry = Task {
      // Idempotent server-side, so overlapping flushes are safe.
      var retry = false
      await withTaskGroup(of: (String, Result<Tap, APIError>).self) { group in
        for (tapId, response) in acks {
          group.addTask {
            do {
              return (tapId, .success(try await api.acknowledge(tapId: tapId, response: response)))
            } catch let error as APIError {
              return (tapId, .failure(error))
            } catch {
              return (tapId, .failure(APIError(code: .network, message: "\(error)", status: 0)))
            }
          }
        }
        for await (tapId, result) in group {
          guard self.api.token == api.token else { continue }
          switch result {
          case let .success(tap):
            dropPendingAck(tapId)
            merge(tap)
          case let .failure(error) where error.isRetryable:
            retry = true
          case .failure:
            dropPendingAck(tapId)
          }
        }
      }
      guard retry, !Task.isCancelled else { return }
      try? await Task.sleep(for: ackRetryDelay)
      guard !Task.isCancelled else { return }
      flushAcks()
    }
  }

  private func dropPendingAck(_ tapId: String) {
    guard pendingAcks[tapId] != nil else { return }
    var acks = pendingAcks
    acks[tapId] = nil
    setPendingAcks(acks)
  }

  // MARK: History

  /// Deletes a tap for everyone: from history, and from every screen if it's
  /// still waiting. One that's already gone counts as deleted.
  public func delete(tapId: String) async throws {
    do {
      try await api.deleteTap(tapId: tapId)
    } catch let error as APIError where error.code == .notFound {}
    drop(tapId)
  }

  // MARK: Pairing management

  public func createSenderInvite() async throws -> SenderInvite {
    let invite = try await api.createInvite(kind: .sender)
    var components = URLComponents(url: endpoints.web.appending(path: "join"), resolvingAgainstBaseURL: false)
    // The code travels in the fragment so it never reaches a server log.
    components?.fragment = invite.code
    guard let url = components?.url else { throw URLError(.badURL) }
    return SenderInvite(url: url, expiresAt: invite.expiresAt)
  }

  // MARK: Push (linked iPhones)

  public func registerPush(_ registration: PushRegistration) async throws {
    try await api.registerPush(registration)
  }

  public func saveActivityToken(tapId: String, token: String) async throws {
    try await api.saveActivityToken(tapId: tapId, token: token)
  }

  /// Removing this device forgets it here even if the server can't be
  /// reached, except when the server refuses (the inbox's last Mac while an
  /// iPhone is still linked): then it stays, and the error says why.
  public func revoke(credentialId id: String) async throws {
    if id == credentialId {
      do {
        try await api.revoke(credentialId: id)
      } catch let error as APIError where error.code == .conflict {
        throw error
      } catch {}
      forget()
      return
    }
    try await api.revoke(credentialId: id)
    resync()
  }
}
