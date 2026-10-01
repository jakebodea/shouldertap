import Foundation

// Codable twins of the contracts in packages/domain/src/contracts.ts. The
// server is the source of truth; Tests/ShouldertapCoreTests decode fixtures
// captured from it so the two can't drift silently.

public let maxTapLength = 280
public let maxReplyLength = 280
public let maxNameLength = 40

/// Epoch milliseconds, as the server sends them.
public typealias Timestamp = Double

public enum PersonColor: String, CaseIterable, Sendable, Codable {
  case moss, cobalt, plum, tomato, ochre, rose, sky, graphite

  /// Unknown colors (a newer server) fall back instead of failing the decode.
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PersonColor(rawValue: raw) ?? .cobalt
  }

  /// `fallbackColor` from packages/domain/src/colors.ts: a stable color for
  /// senders who paired before colors existed.
  public static func fallback(for id: String) -> PersonColor {
    var hash = 0
    for scalar in id.unicodeScalars {
      hash = (hash * 31 + Int(scalar.value)) % 2_147_483_647
    }
    return allCases[hash % allCases.count]
  }

  /// `swatches` from packages/domain/src/colors.ts: `base` is the frame,
  /// `ink` is text and icons set directly on it (sRGB hex).
  public var swatch: (label: String, base: UInt32, ink: UInt32) {
    switch self {
    case .moss: ("Moss", 0x1f5a3d, 0xf4f1e8)
    case .cobalt: ("Cobalt", 0x2340c8, 0xf2f3fb)
    case .plum: ("Plum", 0x6d2657, 0xf8eef3)
    case .tomato: ("Tomato", 0xd9432b, 0xfff4ef)
    case .ochre: ("Ochre", 0xe8b022, 0x1f1a0e)
    case .rose: ("Rose", 0xf2c4bd, 0x3b1219)
    case .sky: ("Sky", 0x9cc9ec, 0x0d2233)
    case .graphite: ("Graphite", 0x2b2c30, 0xf1f1ee)
    }
  }
}

public enum CredentialKind: String, Sendable, Codable {
  case device, sender
}

public struct TapResponse: Sendable, Codable, Hashable {
  public enum Kind: String, Sendable, Codable {
    case onIt = "on_it"
    case in10 = "in_10"
    case text
  }

  public var kind: Kind
  public var text: String?

  public init(kind: Kind, text: String? = nil) {
    self.kind = kind
    self.text = text
  }

  public static let onIt = TapResponse(kind: .onIt)
  public static let in10 = TapResponse(kind: .in10)

  /// `describeResponse` from packages/domain/src/responses.ts.
  public var label: String {
    switch kind {
    case .onIt: "On it"
    case .in10: "In 10 min"
    case .text:
      text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Replied"
    }
  }
}

public struct Tap: Sendable, Codable, Identifiable, Hashable {
  public enum State: String, Sendable, Codable {
    case pending, acknowledged
  }

  public var id: String
  public var senderId: String
  public var senderName: String
  public var senderColor: PersonColor
  public var body: String
  public var createdAt: Timestamp
  public var state: State
  public var displayedAt: Timestamp?
  public var acknowledgedAt: Timestamp?
  public var acknowledgedBy: String?
  public var response: TapResponse?
  public var sequence: Int
}

public struct Credential: Sendable, Codable, Identifiable, Hashable {
  public var id: String
  public var kind: CredentialKind
  public var name: String
  /// Senders only; Macs have no color.
  public var color: PersonColor?
  public var createdAt: Timestamp
  public var lastSeenAt: Timestamp?

  public var swatchColor: PersonColor { color ?? .fallback(for: id) }
}

public struct CredentialGrant: Sendable, Codable {
  public var kind: CredentialKind
  public var credentialId: String
  public var token: String
  public var recipientName: String
}

public struct Invite: Sendable, Codable {
  public var kind: CredentialKind
  public var code: String
  public var expiresAt: Timestamp
}

public struct ConnectTicket: Sendable, Codable {
  public var ticket: String
  public var expiresAt: Timestamp
}

/// What a paired Mac sees: every pending tap plus recent history.
public struct ReceiverSnapshot: Sendable, Decodable {
  public var credentialId: String
  public var recipientName: String
  public var sequence: Int
  public var taps: [Tap]
  public var credentials: [Credential]
}

/// What a sender sees: only their own recent taps.
public struct SenderSnapshot: Sendable, Decodable {
  public var credentialId: String
  public var senderName: String
  public var senderColor: PersonColor
  public var recipientName: String
  public var sequence: Int
  public var taps: [Tap]
}

/// `GET /v1/me`: the shape depends on which kind of credential asked.
public enum Snapshot: Sendable, Decodable {
  case receiver(ReceiverSnapshot)
  case sender(SenderSnapshot)

  private enum CodingKeys: String, CodingKey { case kind }

  public init(from decoder: any Decoder) throws {
    let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .kind)
    self =
      kind == "device"
      ? .receiver(try ReceiverSnapshot(from: decoder)) : .sender(try SenderSnapshot(from: decoder))
  }
}

/// Server → client WebSocket events: versioned JSON envelopes.
public enum ServerEvent: Sendable, Decodable {
  case tap(Tap)
  case credentialsChanged
  case revoked
  /// A newer or unknown event: resync from the snapshot instead.
  case unknown

  private enum CodingKeys: String, CodingKey { case v, type, tap }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard (try? container.decode(Int.self, forKey: .v)) == 1 else {
      self = .unknown
      return
    }
    switch try container.decode(String.self, forKey: .type) {
    case "tap": self = .tap(try container.decode(Tap.self, forKey: .tap))
    case "credentials": self = .credentialsChanged
    case "revoked": self = .revoked
    default: self = .unknown
    }
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
