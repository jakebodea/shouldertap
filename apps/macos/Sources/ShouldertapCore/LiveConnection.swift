import Foundation

public enum LiveStatus: String, Sendable {
  case connecting, live, offline
}

/// Keeps one authorized WebSocket open for server events, like `connectLive`
/// in packages/client/src/live.ts. Commands still go over HTTPS; this only
/// listens. Each connect trades the credential for a one-time ticket.
///
/// Event-driven throughout: it sleeps in `receive()` and wakes only for
/// messages, the 25s keepalive, or a reconnect backoff.
@MainActor
public final class LiveConnection {
  public struct Handlers {
    /// Refetch the authoritative snapshot. Called after every (re)connect and
    /// whenever the server says pairings changed, so a missed event is never lost.
    public var onResync: @MainActor () -> Void
    public var onTap: @MainActor (Tap) -> Void
    public var onStatus: @MainActor (LiveStatus) -> Void
    /// The credential was revoked or is no longer valid. The connection stops.
    public var onRevoked: @MainActor () -> Void

    public init(
      onResync: @escaping @MainActor () -> Void,
      onTap: @escaping @MainActor (Tap) -> Void,
      onStatus: @escaping @MainActor (LiveStatus) -> Void,
      onRevoked: @escaping @MainActor () -> Void
    ) {
      self.onResync = onResync
      self.onTap = onTap
      self.onStatus = onStatus
      self.onRevoked = onRevoked
    }
  }

  private static let backoff: [Duration] = [.seconds(1), .seconds(2), .seconds(5), .seconds(10), .seconds(30)]
  private static let pingInterval: Duration = .seconds(25)

  private let api: APIClient
  private let handlers: Handlers
  private let session: URLSession
  private var loop: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  private var attempt = 0
  private var closed = false

  public init(api: APIClient, handlers: Handlers, session: URLSession = .shared) {
    self.api = api
    self.handlers = handlers
    self.session = session
  }

  public func start() {
    guard !closed else { return }
    loop?.cancel()
    socket?.cancel(with: .goingAway, reason: nil)
    loop = Task { [weak self] in await self?.run() }
  }

  /// Reconnect now, e.g. after wake: a socket that slept is often dead even
  /// when it looks open, and a fresh ticket is cheap.
  public func nudge() {
    guard !closed else { return }
    attempt = 0
    start()
  }

  public func close() {
    closed = true
    loop?.cancel()
    loop = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
  }

  private func run() async {
    while !Task.isCancelled, !closed {
      handlers.onStatus(.connecting)
      do {
        try await connectOnce()
      } catch is CancellationError {
        return
      } catch let error as APIError where error.code == .unauthorized {
        close()
        handlers.onRevoked()
        return
      } catch {
        // Fall through to the backoff.
      }
      guard !Task.isCancelled, !closed else { return }
      handlers.onStatus(.offline)
      let delay = Self.backoff[min(attempt, Self.backoff.count - 1)]
      attempt += 1
      try? await Task.sleep(for: delay)
    }
  }

  /// One connection's lifetime; returns or throws when it ends.
  private func connectOnce() async throws {
    let ticket = try await api.connectTicket()
    try Task.checkCancellation()
    guard let url = api.socketURL(ticket: ticket.ticket) else { throw URLError(.badURL) }

    let socket = session.webSocketTask(with: url)
    self.socket = socket
    socket.resume()
    defer { socket.cancel(with: .goingAway, reason: nil) }

    // The first ping completes once the upgrade has succeeded.
    try await socket.send(.string("ping"))
    attempt = 0
    handlers.onStatus(.live)
    handlers.onResync()

    let keepalive = Task {
      while !Task.isCancelled {
        try await Task.sleep(for: Self.pingInterval, tolerance: .seconds(5))
        try await socket.send(.string("ping"))
      }
    }
    defer { keepalive.cancel() }

    while true {
      let message = try await socket.receive()
      guard case let .string(text) = message, text != "pong" else { continue }
      handle(text)
      if closed { return }
    }
  }

  private func handle(_ text: String) {
    guard let event = try? JSONDecoder().decode(ServerEvent.self, from: Data(text.utf8)) else {
      handlers.onResync()
      return
    }
    switch event {
    case let .tap(tap): handlers.onTap(tap)
    case .credentialsChanged, .unknown: handlers.onResync()
    case .revoked:
      close()
      handlers.onRevoked()
    }
  }
}

/// Insert or replace a tap unless the incoming copy is older. Newest first.
public func mergeTap(_ taps: [Tap], _ incoming: Tap) -> [Tap] {
  if let existing = taps.first(where: { $0.id == incoming.id }), existing.sequence > incoming.sequence {
    return taps
  }
  var next = taps.filter { $0.id != incoming.id }
  next.append(incoming)
  return next.sorted { $0.createdAt > $1.createdAt }
}

/// Replace local state with a snapshot, keeping any newer local copies.
public func mergeSnapshot(local: [Tap], snapshot: [Tap]) -> [Tap] {
  local.reduce(snapshot.sorted { $0.createdAt > $1.createdAt }) { merged, tap in
    guard let fromServer = merged.first(where: { $0.id == tap.id }), fromServer.sequence < tap.sequence
    else { return merged }
    return mergeTap(merged, tap)
  }
}
