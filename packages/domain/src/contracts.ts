import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PersonColor } from "./colors";

export const MAX_TAP_LENGTH = 280;
export const MAX_NAME_LENGTH = 40;
export const MAX_REPLY_LENGTH = 280;

const Name = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_NAME_LENGTH)
  )
);

/** Epoch milliseconds. */
export const Timestamp = Schema.Number;

export const CredentialKind = Schema.Literals(["device", "sender"]);
export type CredentialKind = typeof CredentialKind.Type;

/**
 * What kind of device a "device" credential is. Computers (Macs and Windows
 * PCs) receive taps; an iPhone linked to the inbox manages it (people,
 * devices, history) alongside them.
 */
export const DevicePlatform = Schema.Literals(["mac", "windows", "iphone"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const ResponseKind = Schema.Literals(["on_it", "in_10", "text"]);
export type ResponseKind = typeof ResponseKind.Type;

export const TapResponse = Schema.Struct({
  kind: ResponseKind,
  text: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_REPLY_LENGTH)))
  ),
});
export type TapResponse = typeof TapResponse.Type;

export const TapState = Schema.Literals(["pending", "acknowledged"]);
export type TapState = typeof TapState.Type;

/**
 * How a tap looks on the recipient's computers, chosen by its SENDER. Default
 * is the free Frame; every other value is a whole composition the Mac and
 * Windows apps render natively and the web sender previews. Only an active
 * patron's send is stored with a theme other than Default (the server checks
 * the sender's own patron identity, never the recipient's). Adding one is a
 * protocol change (Swift `TapTheme`, Rust `TapTheme`, the Inbox's CHECK
 * constraint), checked by `scripts/check-protocol-sync.ts`.
 */
export const TAP_THEMES = [
  "default",
  "broadsheet",
  "billboard",
  "terminal",
  "note",
] as const;
export const TapTheme = Schema.Literals(TAP_THEMES);
export type TapTheme = typeof TapTheme.Type;

/** Decodes a theme from a server, falling back to Default for one this client
 * doesn't know (a newer server), instead of failing the whole snapshot. */
export const KnownTapTheme = TapTheme.pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some<TapTheme>("default")))
);

/** `system` follows the computer's Reduce Motion setting; `reduced` always
 * shows the calm entrance. Free, and the recipient's own. */
export const MOTION_PREFERENCES = ["system", "reduced"] as const;
export const MotionPreference = Schema.Literals(MOTION_PREFERENCES);
export type MotionPreference = typeof MotionPreference.Type;

/** The recipient's free override of senders' cosmetics: `show` renders each
 * tap in the theme its sender sent it with; `plain` shows every tap in
 * Default. It never affects delivery, controls or replies. */
export const SENDER_THEME_PREFERENCES = ["show", "plain"] as const;
export const SenderThemePreference = Schema.Literals(SENDER_THEME_PREFERENCES);
export type SenderThemePreference = typeof SenderThemePreference.Type;

export const Tap = Schema.Struct({
  id: Schema.String,
  senderId: Schema.String,
  senderName: Schema.String,
  senderColor: PersonColor,
  body: Schema.String,
  createdAt: Timestamp,
  state: TapState,
  displayedAt: Schema.NullOr(Timestamp),
  acknowledgedAt: Schema.NullOr(Timestamp),
  acknowledgedBy: Schema.NullOr(Schema.String),
  response: Schema.NullOr(TapResponse),
  sequence: Schema.Number,
  /** The sender's theme, captured when the server accepted the tap and never
   * rewritten. Missing from servers older than sender themes and on taps sent
   * before them: show Default. */
  theme: Schema.optionalKey(KnownTapTheme),
});
export type Tap = typeof Tap.Type;

export const Credential = Schema.Struct({
  id: Schema.String,
  kind: CredentialKind,
  name: Schema.String,
  /** Senders only; devices have no color. */
  color: Schema.NullOr(PersonColor),
  /** Devices only; senders have none. */
  platform: Schema.NullOr(DevicePlatform),
  createdAt: Timestamp,
  lastSeenAt: Schema.NullOr(Timestamp),
});
export type Credential = typeof Credential.Type;

// Commands

/**
 * A salted SHA-256 of a computer's hardware UUID, as 64 lowercase hex
 * characters. It names the computer for its one free trial without revealing
 * the hardware id.
 */
export const MachineFingerprint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
);
export type MachineFingerprint = typeof MachineFingerprint.Type;

export const CreateInboxRequest = Schema.Struct({
  recipientName: Name,
  deviceName: Name,
  /** Which computer is setting up, so its trial survives a fresh setup. Older apps omit it. */
  machine: Schema.optionalKey(MachineFingerprint),
  /** Which kind of computer is setting up. Macs omit it. */
  platform: Schema.optionalKey(DevicePlatform),
});
export type CreateInboxRequest = typeof CreateInboxRequest.Type;

export const CredentialGrant = Schema.Struct({
  kind: CredentialKind,
  credentialId: Schema.String,
  token: Schema.String,
  recipientName: Schema.String,
});
export type CredentialGrant = typeof CredentialGrant.Type;

export const CreateInviteRequest = Schema.Struct({
  kind: CredentialKind,
});
export type CreateInviteRequest = typeof CreateInviteRequest.Type;

export const Invite = Schema.Struct({
  kind: CredentialKind,
  code: Schema.String,
  expiresAt: Timestamp,
});
export type Invite = typeof Invite.Type;

export const RedeemInviteRequest = Schema.Struct({
  code: Schema.String,
  name: Name,
  /** The sender's frame color. Ignored when pairing a device. */
  color: Schema.optionalKey(PersonColor),
  /** Which device is joining. Ignored for senders; older Macs omit it. */
  platform: Schema.optionalKey(DevicePlatform),
});
export type RedeemInviteRequest = typeof RedeemInviteRequest.Type;

/** Who an invite is from, shown before accepting it (docs/onboarding.md). */
export const InvitePreview = Schema.Struct({
  name: Schema.String,
  /** The inviter's color; null when they have no account yet. */
  color: Schema.NullOr(PersonColor),
  expiresAt: Schema.Number,
});
export type InvitePreview = typeof InvitePreview.Type;

export const SendTapRequest = Schema.Struct({
  requestId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(8), Schema.isMaxLength(64))
  ),
  body: Schema.String.pipe(
    Schema.check(
      Schema.isTrimmed(),
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_TAP_LENGTH)
    )
  ),
  /** The theme the sender chose. Anything but Default needs `patronKey` of an
   * active patron; otherwise the server stores the tap in Default. Cosmetics
   * never block delivery. Older clients omit both. */
  theme: Schema.optionalKey(TapTheme),
  /** The sender's patron key (`formatPatronKey`), separate from the pairing
   * credential so one membership covers every person they tap. */
  patronKey: Schema.optionalKey(Schema.String),
});
export type SendTapRequest = typeof SendTapRequest.Type;

/** Which APNs a push token belongs to: debug builds use the sandbox. */
export const PushEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushEnvironment = typeof PushEnvironment.Type;

/** An APNs token as the device reports it, in hex. */
const PushToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-fA-F]{16,512}$/u))
);

/**
 * An iPhone's push setup, sent on every launch and whenever it changes. Taps
 * reach a linked iPhone as a Live Activity when it has a push-to-start token
 * and Live Activities are on, otherwise as a Time Sensitive notification. A
 * sender's iPhone registers with its sender key and only needs the device
 * token: answers to its taps arrive as notifications.
 */
export const RegisterPushRequest = Schema.Struct({
  environment: PushEnvironment,
  /** The app's bundle id, the APNs topic. */
  topic: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z0-9.-]{3,155}$/u))
  ),
  deviceToken: Schema.NullOr(PushToken),
  /** `Activity.pushToStartToken` (iOS 17.2 and later). */
  startToken: Schema.NullOr(PushToken),
  liveActivities: Schema.Boolean,
});
export type RegisterPushRequest = typeof RegisterPushRequest.Type;

/** The push token of the Live Activity a tap started on an iPhone. */
export const ActivityTokenRequest = Schema.Struct({
  token: PushToken,
});
export type ActivityTokenRequest = typeof ActivityTokenRequest.Type;

export const AcknowledgeRequest = Schema.Struct({
  response: TapResponse,
});
export type AcknowledgeRequest = typeof AcknowledgeRequest.Type;

export const ConnectTicket = Schema.Struct({
  ticket: Schema.String,
  expiresAt: Timestamp,
});
export type ConnectTicket = typeof ConnectTicket.Type;

// Reads

/** Legacy compatibility only. Free core servers always emit `paid`, so old
 * clients do not display a paywall. Membership is the separate Patron fact. */
export const PlanStatus = Schema.Literals(["trial", "paid", "expired"]);
export type PlanStatus = typeof PlanStatus.Type;

export const Plan = Schema.Struct({
  status: PlanStatus,
  trialEndsAt: Timestamp,
});
export type Plan = typeof Plan.Type;

/** Where a paired Mac sends its person to pay. */
export const Checkout = Schema.Struct({
  url: Schema.String,
});
export type Checkout = typeof Checkout.Type;

/** Annual support state, folded from signed provider facts. */
export const Patron = Schema.Struct({
  active: Schema.Boolean,
  status: Schema.Literals([
    "none",
    "active",
    "ending",
    "payment_issue",
    "inactive",
  ]),
  paidUntil: Schema.NullOr(Timestamp),
  canManage: Schema.Boolean,
  canSubscribe: Schema.Boolean,
  legacySupporter: Schema.Boolean,
});
export type Patron = typeof Patron.Type;

/**
 * The recipient's free settings for their own computers. Servers from the
 * receiver-owned theme experiment also sent `theme`, `shownTheme` and
 * `canChooseTheme`; current clients ignore them.
 */
export const Appearance = Schema.Struct({
  motion: MotionPreference,
  senderThemes: SenderThemePreference,
});
export type Appearance = typeof Appearance.Type;

/** `PUT /v1/appearance`: either field may be left out to keep it. */
export const UpdateAppearanceRequest = Schema.Struct({
  motion: Schema.optionalKey(MotionPreference),
  senderThemes: Schema.optionalKey(SenderThemePreference),
});
export type UpdateAppearanceRequest = typeof UpdateAppearanceRequest.Type;

// Sender patrons

/** A new key for a sender's patron identity: the only proof of membership.
 * Pairing credentials and invite links never carry it. */
export const PatronKeyGrant = Schema.Struct({
  patronId: Schema.String,
  keyId: Schema.String,
  key: Schema.String,
});
export type PatronKeyGrant = typeof PatronKeyGrant.Type;

/** A sender's own membership, read with their patron key. */
export const PatronStatus = Schema.Struct({
  patronId: Schema.String,
  patron: Patron,
  /** Active keys (this device included). */
  keys: Schema.Number,
});
export type PatronStatus = typeof PatronStatus.Type;

/** Whether new patron memberships can start here. Public: no key needed. */
export const PatronAvailability = Schema.Struct({
  checkoutEnabled: Schema.Boolean,
});
export type PatronAvailability = typeof PatronAvailability.Type;

/** One-time code that adds another of the sender's own devices. */
export const PatronLinkCode = Schema.Struct({
  code: Schema.String,
  expiresAt: Timestamp,
});
export type PatronLinkCode = typeof PatronLinkCode.Type;

export const RedeemPatronLinkRequest = Schema.Struct({
  code: Schema.String,
});
export type RedeemPatronLinkRequest = typeof RedeemPatronLinkRequest.Type;

export const ReceiverSnapshot = Schema.Struct({
  kind: Schema.Literal("device"),
  credentialId: Schema.String,
  recipientName: Schema.String,
  sequence: Schema.Number,
  taps: Schema.Array(Tap),
  credentials: Schema.Array(Credential),
  plan: Plan,
  /** Only a historical receiver-owned support subscription, so it can still
   * be managed or canceled. Never used for themes. */
  patron: Schema.optional(Patron),
  /** Missing from older servers: show senders' themes, system motion. */
  appearance: Schema.optional(Appearance),
});
export type ReceiverSnapshot = typeof ReceiverSnapshot.Type;

/** What a sender sees: only their own recent taps. */
export const SenderSnapshot = Schema.Struct({
  kind: Schema.Literal("sender"),
  credentialId: Schema.String,
  senderName: Schema.String,
  senderColor: PersonColor,
  recipientName: Schema.String,
  sequence: Schema.Number,
  taps: Schema.Array(Tap),
});
export type SenderSnapshot = typeof SenderSnapshot.Type;

export const Snapshot = Schema.Union([ReceiverSnapshot, SenderSnapshot]);
export type Snapshot = typeof Snapshot.Type;

// Events (server → client over WebSocket, versioned JSON envelopes)

export const TapEvent = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("tap"),
  sequence: Schema.Number,
  tap: Tap,
});

/** A tap was deleted: drop it from history (and the overlay, if pending). */
export const TapDeletedEvent = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("deleted"),
  sequence: Schema.Number,
  tapId: Schema.String,
});

export const CredentialsChangedEvent = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("credentials"),
  sequence: Schema.Number,
});

export const RevokedEvent = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("revoked"),
});

export const ServerEvent = Schema.Union([
  TapEvent,
  TapDeletedEvent,
  CredentialsChangedEvent,
  RevokedEvent,
]);
export type ServerEvent = typeof ServerEvent.Type;
