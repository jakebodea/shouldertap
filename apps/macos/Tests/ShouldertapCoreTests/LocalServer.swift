import Foundation
import Network

/// A real HTTP server on 127.0.0.1 for what a URLProtocol stub can't see:
/// the headers URLSession actually sends, cookies included. Answers each
/// request with `reply(head)`, where `head` is the request line and headers.
final class LocalServer: @unchecked Sendable {
  typealias Reply = @Sendable (_ head: String) -> (headers: [String], body: String)

  private let listener: NWListener
  private let queue = DispatchQueue(label: "LocalServer")
  private let lock = NSLock()
  private var heads: [String] = []

  /// Every request's line and headers, in order.
  var requests: [String] { lock.withLock { heads } }

  init(reply: @escaping Reply) async throws {
    listener = try NWListener(using: .tcp, on: .any)
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      connection.start(queue: self.queue)
      self.read(connection, Data(), reply)
    }
    try await withCheckedThrowingContinuation { (ready: CheckedContinuation<Void, any Error>) in
      listener.stateUpdateHandler = { [listener] state in
        switch state {
        case .ready: listener.stateUpdateHandler = nil; ready.resume()
        case .failed(let error): listener.stateUpdateHandler = nil; ready.resume(throwing: error)
        default: break
        }
      }
      listener.start(queue: queue)
    }
  }

  var url: URL { URL(string: "http://127.0.0.1:\(listener.port!.rawValue)")! }

  func stop() { listener.cancel() }

  private func read(_ connection: NWConnection, _ received: Data, _ reply: @escaping Reply) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, done, _ in
      let buffer = received + (data ?? Data())
      let text = String(decoding: buffer, as: UTF8.self)
      guard let end = text.range(of: "\r\n\r\n") else {
        if !done { self.read(connection, buffer, reply) }
        return
      }
      let head = String(text[..<end.lowerBound])
      let length = head.split(separator: "\r\n")
        .first { $0.lowercased().hasPrefix("content-length:") }
        .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
      if text[end.upperBound...].utf8.count < length, !done {
        self.read(connection, buffer, reply)
        return
      }
      self.lock.withLock { self.heads.append(head) }
      let (headers, body) = reply(head)
      let response = (["HTTP/1.1 200 OK", "Content-Type: application/json", "Content-Length: \(body.utf8.count)", "Connection: close"] + headers)
        .joined(separator: "\r\n") + "\r\n\r\n" + body
      connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }
  }
}
