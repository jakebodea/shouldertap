import * as Schema from "effect/Schema";

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
  createdAt: Timestamp,
  lastSeenAt: Schema.NullOr(Timestamp),
});
export type Credential = typeof Credential.Type;

// Commands

export const CreateInboxRequest = Schema.Struct({
  recipientName: Name,
  deviceName: Name,
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

/** What a paired Mac sees: every pending tap plus recent history. */
export const ReceiverSnapshot = Schema.Struct({
  kind: Schema.Literal("device"),
  credentialId: Schema.String,
  recipientName: Schema.String,
  sequence: Schema.Number,
  taps: Schema.Array(Tap),
  credentials: Schema.Array(Credential),
});
export type ReceiverSnapshot = typeof ReceiverSnapshot.Type;

/** What a sender sees: only their own recent taps. */
export const SenderSnapshot = Schema.Struct({
  kind: Schema.Literal("sender"),
  credentialId: Schema.String,
  senderName: Schema.String,
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

// Errors on the wire

export const ErrorCode = Schema.Literals([
  "invalid_request",
  "unauthorized",
  "not_found",
  "conflict",
  "expired",
]);
export type ErrorCode = typeof ErrorCode.Type;

export const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: ErrorCode, message: Schema.String }),
});
export type ErrorBody = typeof ErrorBody.Type;

export const errorStatus: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  expired: 410,
};

export class ApiFailure extends Schema.TaggedError<ApiFailure>()("ApiFailure", {
  code: ErrorCode,
  message: Schema.String,
}) {}
