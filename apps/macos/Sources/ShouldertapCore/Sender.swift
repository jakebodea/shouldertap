import Foundation
import Observation

// The sender half of the client: what apps/web does in lib/pairing.ts and
// lib/use-sender.ts, for the native senders (apps/ios and the Mac app). One
// device can be paired with several recipients; each pairing is its own sender credential
// on that recipient's inbox, with its own taps, outbox and live socket.

// MARK: Invites

/// `parseToken` from packages/domain/src/token.ts: `<inboxId>.<id>.<secret>`,
/// each segment 8–64 of `[A-Za-z0-9_-]`. Returns the inbox id, or nil.
public func tokenInboxId(_ value: String) -> String? {
  let parts = value.trimmingCharacters(in: .whitespacesAndNewlines).split(
    separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 3 else { return nil }
  let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
  for part in parts where !(8...64).contains(part.count) || !part.allSatisfy(allowed.contains) {
    return nil
  }
  return String(parts[0])
}

/// The invite code in whatever the sender pasted or opened: a bare code, the
/// web link the Mac shares (`https://shouldertap.app/join#<code>`; the code
/// rides in the fragment so it never reaches a server log), the app's own
/// scheme (`shouldertap://join#<code>`), or either with `?code=<code>`.
public func inviteCode(from input: String) -> String? {
  let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
  if tokenInboxId(trimmed) != nil { return trimmed }
  guard let components = URLComponents(string: trimmed) else { return nil }
  let candidates = [
    components.fragment,
    components.queryItems?.first { $0.name == "code" }?.value,
  ]
  for candidate in candidates.compactMap({ $0 }) {
    let decoded = (candidate.removingPercentEncoding ?? candidate).trimmingCharacters(in: .whitespacesAndNewlines)
    if tokenInboxId(decoded) != nil { return decoded }
  }
  return nil
}

/// `newRequestId` from apps/web/src/lib/ids.ts: 16 random bytes as hex.
public func newRequestId() -> String {
  var generator = SystemRandomNumberGenerator()
  return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }
    .joined()
}

// MARK: Models

/// One recipient this device can tap. `token` is the secret; keep it in the
/// Keychain or an owner-only file. Mirrors `Pairing` in apps/web/src/lib/pairing.ts.
public struct SenderPairing: Sendable, Codable, Hashable, Identifiable {
  public var token: String
  public var credentialId: String
  public var recipientName: String
  public var senderName: String
  /// Missing on pairings made before colors; the snapshot fills it in.
  public var color: PersonColor?
  public var pairedAt: Timestamp

  public var id: String { credentialId }
  public var inboxId: String? { tokenInboxId(token) }
  /// The connection's id on the account (`${inboxId}:${credentialId}`), the
  /// sender `id` sync and accept return; `credentialId` is the person-level id.
  public var accountId: String? { inboxId.map { "\($0):\(credentialId)" } }
  public var swatchColor: PersonColor { color ?? .fallback(for: credentialId) }

  public init(
    token: String, credentialId: String, recipientName: String, senderName: String, color: PersonColor?,
    pairedAt: Timestamp
  ) {
    self.token = token
    self.credentialId = credentialId
    self.recipientName = recipientName
    self.senderName = senderName
    self.color = color
    self.pairedAt = pairedAt
  }
}

/// A send the server hasn't accepted yet. It keeps its request id, so a
/// retry after a dropped connection can't create a duplicate tap.
public struct OutgoingTap: Sendable, Codable, Hashable, Identifiable {
  public var requestId: String
  public var body: String
  public var createdAt: Timestamp
  /// Rejected for good (not a transient failure): offer Try again / Discard.
  public var failed: Bool
  /// Why the server refused it, e.g. the recipient's trial ended.
  public var error: String?
  /// The style it was sent in; nil on outboxes saved before themes (Default).
  public var theme: TapTheme?

  public var id: String { requestId }
}

/// The theme new taps go in, and the patron key that lets a theme other than
/// Default through (`SendTapRequest.theme`/`patronKey`).
public struct SendStyle: Sendable, Equatable {
  public var theme: TapTheme
  public var patronKey: String?

  public init(theme: TapTheme = .default, patronKey: String? = nil) {
    self.theme = theme
    self.patronKey = patronKey
  }
}

/// Where the sender keeps what must survive a restart.
public protocol SenderPersistence: Sendable {
  func loadPairings() -> [SenderPairing]
  func savePairing(_ pairing: SenderPairing) throws
  func deletePairing(credentialId: String)
  func loadOutbox(credentialId: String) -> [OutgoingTap]
  func saveOutbox(_ outbox: [OutgoingTap], credentialId: String)
}

public enum SendError: Error, Equatable, LocalizedError {
  case empty, tooLong

  public var errorDescription: String? {
    switch self {
    case .empty: "Write a message first."
    case .tooLong: "Taps are \(maxTapLength) characters at most."
    }
  }
}

// MARK: One pairing

/// Sender state for one recipient: the authoritative snapshot, live updates,
/// and an outbox of sends that haven't been accepted yet (`useSender`).
@MainActor @Observable
public final class SenderSession: Identifiable {
  public nonisolated let id: String
  public private(set) var pairing: SenderPairing
  /// Newest first.
  public private(set) var taps: [Tap] = []
  /// Newest first.
  public private(set) var outbox: [OutgoingTap]
  public private(set) var status: LiveStatus = .connecting
  /// The first snapshot arrived, so an empty history really is empty.
  public private(set) var loaded = false

  public var color: PersonColor { pairing.swatchColor }

  @ObservationIgnored private let persistence: any SenderPersistence
  @ObservationIgnored private let api: APIClient
  @ObservationIgnored private let session: URLSession
  @ObservationIgnored private let onRevoked: @MainActor (SenderSession) -> Void
  @ObservationIgnored private let style: @MainActor () -> SendStyle
  @ObservationIgnored private let onSent: @MainActor (Tap) -> Void
  @ObservationIgnored private var live: LiveConnection?
  @ObservationIgnored private var inFlight: Set<String> = []

  init(
    pairing: SenderPairing, server: URL, persistence: any SenderPersistence, session: URLSession,
    style: @escaping @MainActor () -> SendStyle, onSent: @escaping @MainActor (Tap) -> Void,
    onRevoked: @escaping @MainActor (SenderSession) -> Void
  ) {
    id = pairing.credentialId
    self.pairing = pairing
    self.persistence = persistence
    self.session = session
    self.style = style
    self.onSent = onSent
    self.onRevoked = onRevoked
    api = APIClient(baseURL: server, token: pairing.token, session: session)
    outbox = persistence.loadOutbox(credentialId: pairing.credentialId)
  }

  func start() {
    live?.close()
    let live = LiveConnection(
      api: api,
      handlers: .init(
        onResync: { [weak self] in self?.resync() },
        onTap: { [weak self] tap in self?.merge(tap) },
        onTapDeleted: { [weak self] tapId in self?.taps.removeAll { $0.id == tapId } },
        onStatus: { [weak self] status in self?.status = status },
        onRevoked: { [weak self] in self?.revoked() }
      ), session: session)
    self.live = live
    live.start()
  }

  /// Reconnect now (app came to the foreground, network changed).
  public func nudge() {
    live?.nudge()
  }

  func stop() {
    live?.close()
    live = nil
    status = .offline
  }

  /// Revoke this phone’s key. Account-restored keys leave the sender’s
  /// other devices connected. Best effort: forget this phone either way.
  func revokeSelf() {
    let api = api
    let components = pairing.token.split(separator: ".")
    guard components.count == 3 else { return }
    let keyID = String(components[1])
    Task { try? await api.revoke(credentialId: keyID) }
  }

  /// This phone's push setup, so the server can say when a tap from here
  /// is answered.
  public func registerPush(_ registration: PushRegistration) async throws {
    try await api.registerPush(registration)
  }

  // MARK: Sending

  /// Queue a tap and deliver it. Throws only for drafts the server would
  /// reject anyway; network trouble leaves it in the outbox to retry.
  public func send(_ body: String) throws(SendError) {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .empty }
    guard trimmed.count <= maxTapLength else { throw .tooLong }
    let item = OutgoingTap(
      requestId: newRequestId(), body: trimmed, createdAt: Date.now.timeIntervalSince1970 * 1000, failed: false,
      theme: style().theme)
    updateOutbox { [item] + $0 }
    deliver(item)
  }

  /// A failed send, again, as a fresh request (like the web's "Try again").
  public func retry(requestId: String) {
    guard let item = outbox.first(where: { $0.requestId == requestId }) else { return }
    discard(requestId: requestId)
    var again = item
    again.requestId = newRequestId()
    again.createdAt = Date.now.timeIntervalSince1970 * 1000
    again.failed = false
    again.error = nil
    updateOutbox { [again] + $0 }
    deliver(again)
  }

  public func discard(requestId: String) {
    updateOutbox { $0.filter { $0.requestId != requestId } }
  }

  private func deliver(_ item: OutgoingTap) {
    guard inFlight.insert(item.requestId).inserted else { return }
    let api = api
    let patronKey = style().patronKey
    Task {
      defer { inFlight.remove(item.requestId) }
      do {
        let tap = try await api.sendTap(
          requestId: item.requestId, body: item.body, theme: item.theme ?? .default, patronKey: patronKey)
        updateOutbox { $0.filter { $0.requestId != item.requestId } }
        merge(tap)
        onSent(tap)
      } catch let error as APIError where error.code == .unauthorized {
        revoked()
      } catch {
        // Transient failures stay queued and go again on the next resync.
        // Refusals (including a 402 once the recipient's trial ends) are
        // marked failed with the server's message and never retried alone.
        let apiError = error as? APIError
        let failed = !(apiError?.isRetryable ?? true)
        updateOutbox { outbox in
          outbox.map {
            guard $0.requestId == item.requestId else { return $0 }
            var updated = $0
            updated.failed = failed
            updated.error = failed ? apiError?.message : nil
            return updated
          }
        }
      }
    }
  }

  /// Deletes one of your taps for everyone, including from their screens if
  /// they haven't answered. One that's already gone counts as deleted.
  public func delete(tapId: String) async throws {
    do {
      try await api.deleteTap(tapId: tapId)
    } catch let error as APIError where error.code == .notFound {}
    taps.removeAll { $0.id == tapId }
  }

  private func updateOutbox(_ update: ([OutgoingTap]) -> [OutgoingTap]) {
    outbox = update(outbox)
    persistence.saveOutbox(outbox, credentialId: pairing.credentialId)
  }

  // MARK: Sync

  /// Refetch the snapshot, then push anything still queued.
  func resync() {
    let api = api
    Task {
      do {
        guard case let .sender(snapshot) = try await api.me() else { return }
        taps = mergeSnapshot(local: taps, snapshot: snapshot.taps)
        loaded = true
        // Pairings made before colors existed learn theirs here.
        if pairing.color == nil || pairing.recipientName != snapshot.recipientName {
          pairing.color = pairing.color ?? snapshot.senderColor
          pairing.recipientName = snapshot.recipientName
          try? persistence.savePairing(pairing)
        }
      } catch let error as APIError where error.code == .unauthorized {
        revoked()
        return
      } catch {
        return
      }
      for item in outbox where !item.failed {
        deliver(item)
      }
    }
  }

  private func merge(_ tap: Tap) {
    taps = mergeTap(taps, tap)
  }

  private func revoked() {
    stop()
    onRevoked(self)
  }
}

// MARK: All pairings

/// Every recipient this device can tap, persisted and connected.
@MainActor @Observable
public final class SenderStore {
  /// Oldest pairing first.
  public private(set) var sessions: [SenderSession] = []
  /// Something the sender should hear about once, e.g. a removed pairing.
  public var notice: String?
  /// How new taps from this device look, and the key that lets them.
  /// Defaults to Default with no key (the iPhone, and anyone not a patron).
  @ObservationIgnored public var style: @MainActor () -> SendStyle = { SendStyle() }
  /// The server accepted a tap from this device.
  @ObservationIgnored public var onSent: @MainActor (Tap) -> Void = { _ in }

  @ObservationIgnored private let server: URL
  @ObservationIgnored private let persistence: any SenderPersistence
  @ObservationIgnored private let session: URLSession

  public init(server: URL, persistence: any SenderPersistence, session: URLSession = .shared) {
    self.server = server
    self.persistence = persistence
    self.session = session
  }

  public func start() {
    sessions.forEach { $0.stop() }
    sessions = persistence.loadPairings().sorted { $0.pairedAt < $1.pairedAt }.map(makeSession)
    sessions.forEach { $0.start() }
  }

  public func session(id: String) -> SenderSession? {
    sessions.first { $0.id == id }
  }

  /// Back in the foreground: sockets that slept are often dead.
  public func nudge() {
    sessions.forEach { $0.nudge() }
  }

  /// Keep a sender key the account issued (`/account/sync` or
  /// `/account/accept`): no redeem call, the grant carries everything. A new
  /// key for someone this device already taps replaces the old one.
  @discardableResult
  public func add(_ sender: SenderGrant) throws -> SenderSession {
    let grant = sender.grant
    guard grant.kind == .sender, let inboxId = tokenInboxId(grant.token) else {
      throw APIError(code: .invalidRequest, message: "That isn’t a key to tap someone.", status: 400)
    }
    if let existing = sessions.first(where: { $0.pairing.token == grant.token }) { return existing }
    let pairing = SenderPairing(
      token: grant.token, credentialId: grant.credentialId, recipientName: grant.recipientName,
      senderName: sender.name, color: sender.color, pairedAt: Date.now.timeIntervalSince1970 * 1000)
    for existing in sessions where existing.pairing.inboxId == inboxId {
      forget(id: existing.id)
    }
    try persistence.savePairing(pairing)
    let session = makeSession(pairing)
    sessions.append(session)
    session.start()
    return session
  }

  /// The account says these connections are gone (`removed`): forget them
  /// here without revoking anything.
  public func drop(tokens: Set<String>) {
    for session in sessions where tokens.contains(session.pairing.token) {
      forget(id: session.id)
    }
  }

  /// Unpair this phone: revoke the credential so the recipient's Mac stops
  /// listing the sender, then forget the pairing here.
  public func unpair(id: String) {
    guard let session = session(id: id) else { return }
    session.stop()
    session.revokeSelf()
    forget(id: id)
  }

  /// Keep the credential until the server confirms deletion so a failed
  /// connection can be retried without losing access to the stored data.
  public func deleteData(id: String) async throws {
    guard let pairing = session(id: id)?.pairing else { return }
    let api = APIClient(baseURL: server, token: pairing.token, session: session)
    try await api.deleteSender()
    forget(id: id)
  }

  /// Forget a pairing on this phone without telling the server, e.g. once
  /// the recipient has already removed it.
  private func forget(id: String) {
    guard let session = session(id: id) else { return }
    session.stop()
    persistence.deletePairing(credentialId: id)
    persistence.saveOutbox([], credentialId: id)
    sessions.removeAll { $0.id == id }
  }

  private func makeSession(_ pairing: SenderPairing) -> SenderSession {
    SenderSession(
      pairing: pairing, server: server, persistence: persistence, session: session,
      style: { [weak self] in self?.style() ?? SendStyle() },
      onSent: { [weak self] tap in self?.onSent(tap) },
      onRevoked: { [weak self] session in
        self?.notice = "\(session.pairing.recipientName) removed this pairing"
        self?.forget(id: session.id)
      })
  }
}
