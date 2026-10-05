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
}

public struct SenderInvite: Sendable {
  public var url: URL
  public var expiresAt: Timestamp
}

/// All Mac client behavior in one place: the device credential, the live
/// connection, which tap the overlay shows, and acknowledgements that must
/// survive being offline. The UI only draws what this decides. A linked
/// iPhone uses it too, to manage the inbox (`platform: .iphone`); it never
/// reports taps as displayed.
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
  public private(set) var taps: [Tap] = []
  public private(set) var status: LiveStatus = .connecting
  /// Responses given on this Mac that the server hasn't confirmed yet.
  public private(set) var pendingAcks: [String: TapResponse] = [:]

  @ObservationIgnored private let endpoints: Endpoints
  @ObservationIgnored private let persistence: any ReceiverPersistence
  @ObservationIgnored private let deviceName: @MainActor () -> String
  @ObservationIgnored private let platform: DevicePlatform
  @ObservationIgnored private let machine: @MainActor () -> String?
  @ObservationIgnored private var api: APIClient
  @ObservationIgnored private var live: LiveConnection?
  @ObservationIgnored private var ackRetry: Task<Void, Never>?
  @ObservationIgnored private var reportedDisplayed: Set<String> = []
  @ObservationIgnored private let session: URLSession
  @ObservationIgnored private let ackRetryDelay: Duration

  public init(
    endpoints: Endpoints,
    persistence: any ReceiverPersistence,
    deviceName: @escaping @MainActor () -> String,
    platform: DevicePlatform = .mac,
    machine: @escaping @MainActor () -> String? = { nil },
    session: URLSession = .shared,
    ackRetryDelay: Duration = .seconds(10)
  ) {
    self.endpoints = endpoints
    self.persistence = persistence
    self.deviceName = deviceName
    self.platform = platform
    self.machine = machine
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

  /// Where to pay for this inbox. If it turns out to be paid for already
  /// (`conflict`), the snapshot is refreshed so the menu catches up.
  public func checkoutURL() async throws -> URL {
    do {
      return try await api.createCheckout().url
    } catch let error as APIError where error.code == .conflict {
      resync()
      throw error
    }
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
    Task {
      do {
        merge(try await api.markDisplayed(tapId: tapId))
      } catch {
        reportedDisplayed.remove(tapId)
      }
    }
  }

  // MARK: Setup

  /// Sends this Mac's fingerprint so its free trial carries over a fresh
  /// setup. Joining an existing inbox (`join`) doesn't: that inbox's plan
  /// already applies.
  public func createInbox(recipientName: String) async throws {
    let grant = try await api.createInbox(
      recipientName: recipientName, deviceName: safeDeviceName(), machine: machine())
    try persistence.saveCredential(grant.token)
    connect(grant.token)
  }

  /// `code` is the bare code, or the link an iPhone scans
  /// (`shouldertap://link#<code>`).
  public func join(code: String) async throws {
    let code = inviteCode(from: code) ?? code.trimmingCharacters(in: .whitespacesAndNewlines)
    let grant = try await api.redeemInvite(code: code, name: safeDeviceName(), platform: platform)
    guard grant.kind == .device else {
      throw APIError(
        code: .invalidRequest,
        message: platform == .mac
          ? "That's a sender invite. Open it on the phone that will send taps."
          : "That's an invite to tap someone. To link your Mac, use the code under Your devices.",
        status: 400)
    }
    try persistence.saveCredential(grant.token)
    connect(grant.token)
  }

  private func safeDeviceName() -> String {
    String(deviceName().prefix(maxNameLength)).trimmingCharacters(in: .whitespaces).nilIfEmpty
      ?? (platform == .mac ? "Mac" : "iPhone")
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
        onTap: { [weak self] tap in self?.merge(tap) },
        onTapDeleted: { [weak self] tapId in self?.drop(tapId) },
        onStatus: { [weak self] status in self?.status = status },
        onRevoked: { [weak self] in self?.forget() }
      ), session: session)
    self.live = live
    live.start()
  }

  private func resync() {
    Task {
      do {
        guard case let .receiver(snapshot) = try await api.me() else { return }
        recipientName = snapshot.recipientName
        credentialId = snapshot.credentialId
        credentials = snapshot.credentials
        plan = snapshot.plan
        taps = mergeSnapshot(local: taps, snapshot: snapshot.taps)
      } catch let error as APIError where error.code == .unauthorized {
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

  public func createDeviceCode() async throws -> Invite {
    try await api.createInvite(kind: .device)
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
