import Foundation
import Observation

// The sender half of the client: what apps/web does in lib/pairing.ts and
// lib/use-sender.ts, for the native iOS sender (apps/ios). One phone can be
// paired with several recipients; each pairing is its own sender credential
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

/// One recipient this phone can tap. `token` is the secret; keep it in the
/// Keychain. Mirrors `Pairing` in apps/web/src/lib/pairing.ts.
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

  public var id: String { requestId }
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
  @ObservationIgnored private var live: LiveConnection?
  @ObservationIgnored private var inFlight: Set<String> = []

  init(
    pairing: SenderPairing, server: URL, persistence: any SenderPersistence, session: URLSession,
    onRevoked: @escaping @MainActor (SenderSession) -> Void
  ) {
    id = pairing.credentialId
    self.pairing = pairing
    self.persistence = persistence
    self.session = session
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

  // MARK: Sending

  /// Queue a tap and deliver it. Throws only for drafts the server would
  /// reject anyway; network trouble leaves it in the outbox to retry.
  public func send(_ body: String) throws(SendError) {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw .empty }
    guard trimmed.count <= maxTapLength else { throw .tooLong }
    let item = OutgoingTap(
      requestId: newRequestId(), body: trimmed, createdAt: Date.now.timeIntervalSince1970 * 1000, failed: false)
    updateOutbox { [item] + $0 }
    deliver(item)
  }

  /// A failed send, again, as a fresh request (like the web's "Try again").
  public func retry(requestId: String) {
    guard let item = outbox.first(where: { $0.requestId == requestId }) else { return }
    discard(requestId: requestId)
    try? send(item.body)
  }

  public func discard(requestId: String) {
    updateOutbox { $0.filter { $0.requestId != requestId } }
  }

  private func deliver(_ item: OutgoingTap) {
    guard inFlight.insert(item.requestId).inserted else { return }
    let api = api
    Task {
      defer { inFlight.remove(item.requestId) }
      do {
        let tap = try await api.sendTap(requestId: item.requestId, body: item.body)
        updateOutbox { $0.filter { $0.requestId != item.requestId } }
        merge(tap)
      } catch let error as APIError where error.code == .unauthorized {
        revoked()
      } catch {
        // Transient failures stay queued and go again on the next resync.
        let failed = !((error as? APIError)?.isRetryable ?? true)
        updateOutbox { outbox in
          outbox.map { $0.requestId == item.requestId ? OutgoingTap(
            requestId: $0.requestId, body: $0.body, createdAt: $0.createdAt, failed: failed) : $0 }
        }
      }
    }
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

/// Every recipient this phone can tap, persisted and connected.
@MainActor @Observable
public final class SenderStore {
  /// Oldest pairing first.
  public private(set) var sessions: [SenderSession] = []
  /// Something the sender should hear about once, e.g. a removed pairing.
  public var notice: String?

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

  /// Redeem a sender invite. Pairing again with the same recipient replaces
  /// that pairing, like the web.
  @discardableResult
  public func pair(invite: String, name: String, color: PersonColor) async throws -> SenderSession {
    guard let code = inviteCode(from: invite) else {
      throw APIError(
        code: .invalidRequest, message: "That doesn't look like a Shouldertap invite link.", status: 400)
    }
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...maxNameLength).contains(name.count) else {
      throw APIError(
        code: .invalidRequest, message: "Enter your name (up to \(maxNameLength) characters).", status: 400)
    }
    let grant = try await APIClient(baseURL: server, session: session)
      .redeemInvite(code: code, name: name, color: color)
    guard grant.kind == .sender else {
      throw APIError(
        code: .invalidRequest,
        message: "That code is for pairing another Mac. Enter it in the Shouldertap Mac app.", status: 400)
    }
    let pairing = SenderPairing(
      token: grant.token, credentialId: grant.credentialId, recipientName: grant.recipientName,
      senderName: name, color: color, pairedAt: Date.now.timeIntervalSince1970 * 1000)
    try persistence.savePairing(pairing)
    for existing in sessions where existing.pairing.inboxId == pairing.inboxId {
      unpair(id: existing.id)
    }
    let session = makeSession(pairing)
    sessions.append(session)
    session.start()
    return session
  }

  /// Forget a pairing on this phone. The recipient still lists the sender
  /// until they remove it on their Mac (senders can't revoke credentials).
  public func unpair(id: String) {
    guard let session = session(id: id) else { return }
    session.stop()
    persistence.deletePairing(credentialId: id)
    persistence.saveOutbox([], credentialId: id)
    sessions.removeAll { $0.id == id }
  }

  private func makeSession(_ pairing: SenderPairing) -> SenderSession {
    SenderSession(
      pairing: pairing, server: server, persistence: persistence, session: session,
      onRevoked: { [weak self] session in
        self?.notice = "\(session.pairing.recipientName) removed this pairing"
        self?.unpair(id: session.id)
      })
  }
}
