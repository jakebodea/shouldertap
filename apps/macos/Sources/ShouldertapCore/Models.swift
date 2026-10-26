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

/// What kind of device a `device` credential is: computers (Macs and
/// Windows PCs) show taps; a linked iPhone manages the inbox alongside them.
public enum DevicePlatform: String, Sendable, Codable {
  case mac, windows, iphone

  /// Computers cover other apps; iPhone shows a takeover only while open.
  public var showsDesktopOverlay: Bool { self != .iphone }

  /// Unknown platforms (a newer server) read as a Mac instead of failing the decode.
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = DevicePlatform(rawValue: raw) ?? .mac
  }
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
  /// The theme its sender sent it with, fixed by the server when it accepted
  /// the tap. Missing from older servers and older taps; unknown values from a
  /// newer server decode as Default.
  public var theme: TapTheme?

  /// What the sender chose, Default when they chose nothing.
  public var senderTheme: TapTheme { theme ?? .default }

  public init(
    id: String, senderId: String, senderName: String, senderColor: PersonColor, body: String, createdAt: Timestamp,
    state: State = .pending, displayedAt: Timestamp? = nil, acknowledgedAt: Timestamp? = nil,
    acknowledgedBy: String? = nil, response: TapResponse? = nil, sequence: Int = 0, theme: TapTheme? = nil
  ) {
    self.id = id
    self.senderId = senderId
    self.senderName = senderName
    self.senderColor = senderColor
    self.body = body
    self.createdAt = createdAt
    self.state = state
    self.displayedAt = displayedAt
    self.acknowledgedAt = acknowledgedAt
    self.acknowledgedBy = acknowledgedBy
    self.response = response
    self.sequence = sequence
    self.theme = theme
  }
}

public struct Credential: Sendable, Codable, Identifiable, Hashable {
  public var id: String
  public var kind: CredentialKind
  public var name: String
  /// Senders only; devices have no color.
  public var color: PersonColor?
  /// Devices only. Missing from servers older than iPhone linking: a Mac.
  public var platform: DevicePlatform?
  public var createdAt: Timestamp
  public var lastSeenAt: Timestamp?

  public var swatchColor: PersonColor { color ?? .fallback(for: id) }
  /// For devices: a Mac unless it says otherwise.
  public var devicePlatform: DevicePlatform { platform ?? .mac }
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

  public init(status: Status, trialEndsAt: Timestamp) {
    self.status = status
    self.trialEndsAt = trialEndsAt
  }

  /// Whole days of trial left as of `now`, rounded up: 1 on the last day,
  /// 0 once it has ended.
  public func daysLeft(now: Date = .now) -> Int {
    let remaining = trialEndsAt - now.timeIntervalSince1970 * 1000
    guard remaining > 0 else { return 0 }
    return Int((remaining / 86_400_000).rounded(.up))
  }

  /// The status as of `now`: a trial that ran out since the last snapshot is
  /// expired on older servers. Free-core servers always send `paid`.
  public func currentStatus(now: Date = .now) -> Status {
    status == .trial && daysLeft(now: now) == 0 ? .expired : status
  }
}

/// Which APNs a push token belongs to: debug and simulator builds use the
/// sandbox.
public enum PushEnvironment: String, Sendable, Codable {
  case sandbox, production
}

/// An iPhone's push setup (`PUT /v1/push`): a tap reaches a linked iPhone as
/// a Live Activity when it has a start token and Live Activities are on,
/// otherwise as a notification. Sent with a sender key, it's where answers to
/// that sender's taps go.
public struct PushRegistration: Sendable, Codable, Hashable {
  public var environment: PushEnvironment
  /// The app's bundle id.
  public var topic: String
  public var deviceToken: String?
  public var startToken: String?
  public var liveActivities: Bool

  public init(
    environment: PushEnvironment, topic: String, deviceToken: String?, startToken: String?, liveActivities: Bool
  ) {
    self.environment = environment
    self.topic = topic
    self.deviceToken = deviceToken
    self.startToken = startToken
    self.liveActivities = liveActivities
  }

  // Tokens are sent as null rather than left out: the contract requires them.
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(environment, forKey: .environment)
    try container.encode(topic, forKey: .topic)
    try container.encode(deviceToken, forKey: .deviceToken)
    try container.encode(startToken, forKey: .startToken)
    try container.encode(liveActivities, forKey: .liveActivities)
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
  public var patron: Patron?
  /// Missing from servers older than themes.
  public var appearance: Appearance?

  private enum CodingKeys: String, CodingKey {
    case credentialId, recipientName, sequence, taps, credentials, plan, patron, appearance
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
    patron = try? container.decodeIfPresent(Patron.self, forKey: .patron)
    appearance = try? container.decodeIfPresent(Appearance.self, forKey: .appearance)
  }
}

public struct Patron: Sendable, Decodable, Hashable {
  public var active: Bool
  public var status: String
  public var paidUntil: Timestamp?
  public var canManage: Bool
  public var canSubscribe: Bool
  public var legacySupporter: Bool
}

/// `TapTheme` from packages/domain/src/contracts.ts: how a tap looks on the
/// recipient's computers, chosen by its sender (an active patron) and carried
/// on the tap. Each case is a whole composition the overlay renders natively;
/// there is no free-form styling and nothing from the sender but text.
public enum TapTheme: String, CaseIterable, Sendable, Codable, Hashable {
  case `default`, broadsheet, billboard, terminal, note

  /// Unknown themes (a newer server) show Default instead of failing the decode.
  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = TapTheme(rawValue: raw) ?? .default
  }

  public var label: String {
    switch self {
    case .default: "Default"
    case .broadsheet: "Broadsheet"
    case .billboard: "Billboard"
    case .terminal: "Terminal"
    case .note: "Note"
    }
  }
}

/// `system` follows the computer's Reduce Motion; `reduced` always shows the
/// calm entrance.
public enum MotionPreference: String, CaseIterable, Sendable, Codable, Hashable {
  case system, reduced

  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MotionPreference(rawValue: raw) ?? .system
  }
}

/// Legacy wire values, retained for compatibility. They do not control rendering.
public enum SenderThemePreference: String, CaseIterable, Sendable, Codable, Hashable {
  /// Each tap in the theme its sender sent it with.
  case show
  /// Every tap in Default.
  case plain

  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = SenderThemePreference(rawValue: raw) ?? .show
  }
}

/// The recipient's free settings, owned by the server and shared by every
/// computer on the inbox. Nothing here is billed: themes come from senders.
public struct Appearance: Sendable, Decodable, Hashable {
  public var motion: MotionPreference
  public var senderThemes: SenderThemePreference

  public init(motion: MotionPreference, senderThemes: SenderThemePreference) {
    self.motion = motion
    self.senderThemes = senderThemes
  }

  /// Older servers: senders' themes shown, following the system.
  public static let standard = Appearance(motion: .system, senderThemes: .show)

  private enum CodingKeys: String, CodingKey { case motion, senderThemes }

  /// Each field falls back on its own, so one odd value never costs the rest.
  /// The receiver-owned theme experiment's `theme`/`shownTheme` are ignored.
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    motion = (try? container.decode(MotionPreference.self, forKey: .motion)) ?? .system
    senderThemes = (try? container.decode(SenderThemePreference.self, forKey: .senderThemes)) ?? .show
  }

  /// The theme to draw `tap` in: its sender's style.
  public func theme(for tap: Tap) -> TapTheme {
    tap.senderTheme
  }

  /// Calm entrances when the system asks for them or the recipient does.
  public func reducesMotion(systemSetting: Bool) -> Bool {
    systemSetting || motion == .reduced
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
  /// A tap was deleted, for everyone: drop it.
  case tapDeleted(String)
  case credentialsChanged
  case revoked
  /// A newer or unknown event: resync from the snapshot instead.
  case unknown

  private enum CodingKeys: String, CodingKey { case v, type, tap, tapId }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard (try? container.decode(Int.self, forKey: .v)) == 1 else {
      self = .unknown
      return
    }
    switch try container.decode(String.self, forKey: .type) {
    case "tap": self = .tap(try container.decode(Tap.self, forKey: .tap))
    case "deleted": self = .tapDeleted(try container.decode(String.self, forKey: .tapId))
    case "credentials": self = .credentialsChanged
    case "revoked": self = .revoked
    default: self = .unknown
    }
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
