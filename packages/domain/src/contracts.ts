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
 * What kind of device a "device" credential is. Macs receive taps; an iPhone
 * linked to the inbox manages it (people, devices, history) alongside them.
 */
export const DevicePlatform = Schema.Literals(["mac", "iphone"]);
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
 * A salted SHA-256 of a Mac's hardware UUID, as 64 lowercase hex characters.
 * It names the Mac for its one free trial without revealing the hardware id.
 */
export const MachineFingerprint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))
);
export type MachineFingerprint = typeof MachineFingerprint.Type;

export const CreateInboxRequest = Schema.Struct({
  recipientName: Name,
  deviceName: Name,
  /** Which Mac is setting up, so its trial survives a fresh setup. Older apps omit it. */
  machine: Schema.optionalKey(MachineFingerprint),
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
});
export type SendTapRequest = typeof SendTapRequest.Type;

/** Which APNs a push token belongs to: debug builds use the sandbox. */
export const PushEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushEnvironment = typeof PushEnvironment.Type;

/** An APNs token as the device reports it, in hex. */
const PushToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-fA-F]{16,512}$/))
);

/**
 * A linked iPhone's push setup, sent on every launch and whenever it
 * changes. Taps reach it as a Live Activity when it has a push-to-start token
 * and Live Activities are on, otherwise as a Time Sensitive notification.
 */
export const RegisterPushRequest = Schema.Struct({
  environment: PushEnvironment,
  /** The app's bundle id, the APNs topic. */
  topic: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z0-9.-]{3,155}$/))
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

/**
 * Whether the inbox delivers taps: during its free trial, once paid for, or
 * neither ("expired").
 */
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

/** What a paired Mac sees: every pending tap plus recent history. */
export const ReceiverSnapshot = Schema.Struct({
  kind: Schema.Literal("device"),
  credentialId: Schema.String,
  recipientName: Schema.String,
  sequence: Schema.Number,
  taps: Schema.Array(Tap),
  credentials: Schema.Array(Credential),
  plan: Plan,
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
  CredentialsChangedEvent,
  RevokedEvent,
]);
export type ServerEvent = typeof ServerEvent.Type;
