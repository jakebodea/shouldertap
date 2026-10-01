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

/// Whether the inbox delivers taps: during its free trial, once paid for, or
/// neither (`expired`).
public struct Plan: Sendable, Codable, Hashable {
  public enum Status: String, Sendable, Codable {
    case trial, paid, expired
  }

  public var status: Status
  public var trialEndsAt: Timestamp
  /// What unlocking costs right now, in US cents; nil from older servers.
  public var unlockPrice: Int?

  /// Mirrors packages/domain/src/pricing.ts.
  public static let trialPriceCents = 500
  public static let fullPriceCents = 1000

  public init(status: Status, trialEndsAt: Timestamp, unlockPrice: Int? = nil) {
    self.status = status
    self.trialEndsAt = trialEndsAt
    self.unlockPrice = unlockPrice
  }

  /// The price as of `now`: the trial price only while the trial is still
  /// running here, even if the last snapshot said otherwise.
  public func price(now: Date = .now) -> Int {
    currentStatus(now: now) == .trial
      ? (unlockPrice ?? Self.trialPriceCents) : Self.fullPriceCents
  }

  /// "$5", "$10", "$4.99".
  public static func format(cents: Int) -> String {
    cents % 100 == 0 ? "$\(cents / 100)" : String(format: "$%.2f", Double(cents) / 100)
  }

  /// Whole days of trial left as of `now`, rounded up: 1 on the last day,
  /// 0 once it has ended.
  public func daysLeft(now: Date = .now) -> Int {
    let remaining = trialEndsAt - now.timeIntervalSince1970 * 1000
    guard remaining > 0 else { return 0 }
    return Int((remaining / 86_400_000).rounded(.up))
  }

  /// The status as of `now`: a trial that ran out since the last snapshot is
  /// already expired (the server refuses taps from then on too).
  public func currentStatus(now: Date = .now) -> Status {
    status == .trial && daysLeft(now: now) == 0 ? .expired : status
  }
}

/// Where a paired Mac sends its person to pay.
public struct Checkout: Sendable, Codable {
  public var url: URL
}

/// What a paired Mac sees: every pending tap plus recent history.
public struct ReceiverSnapshot: Sendable, Decodable {
  public var credentialId: String
  public var recipientName: String
  public var sequence: Int
  public var taps: [Tap]
  public var credentials: [Credential]
  /// Missing from servers older than payments; the menu then shows no plan.
  public var plan: Plan?

  private enum CodingKeys: String, CodingKey {
    case credentialId, recipientName, sequence, taps, credentials, plan
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    credentialId = try container.decode(String.self, forKey: .credentialId)
    recipientName = try container.decode(String.self, forKey: .recipientName)
    sequence = try container.decode(Int.self, forKey: .sequence)
    taps = try container.decode([Tap].self, forKey: .taps)
    credentials = try container.decode([Credential].self, forKey: .credentials)
    // A plan shaped differently by a newer server mustn't fail the snapshot.
    plan = try? container.decodeIfPresent(Plan.self, forKey: .plan)
  }
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
