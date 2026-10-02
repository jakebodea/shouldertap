import {
  type AcknowledgeRequest,
  Conflict,
  type ConnectTicket,
  type CreateInboxRequest,
  type CreateInviteRequest,
  type Credential,
  type CredentialGrant,
  type CredentialKind,
  type DevicePlatform,
  Expired,
  fallbackColor,
  formatToken,
  InvalidRequest,
  type Invite,
  NotFound,
  type ParsedToken,
  PaymentRequired,
  type PersonColor,
  parseToken,
  type RedeemInviteRequest,
  type SendTapRequest,
  type ServerEvent,
  type Snapshot,
  type Tap,
  TooManyRequests,
  Unauthorized,
} from "@shouldertap/domain";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle/Cloudflare";
import { and, count, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import migrations from "../drizzle/migrations.js";
import { isObjectionable } from "./content";
import { planOf, requireActivePlan, TRIAL_MS } from "./plan";
import { retentionFilters } from "./retention";
import { credentials, inbox, invites, taps, tickets } from "./schema";

const SENDER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_INVITE_TTL_MS = 15 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const HISTORY_LIMIT = 25;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

/** Taps one sender may send in any rolling hour. */
const TAPS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
/** Active (non-revoked) pairings an inbox may hold, by kind. */
const PAIRING_CAPS: Record<CredentialKind, number> = {
  sender: 20,
  device: 10,
};

/** A purchase reported by Creem's checkout.completed webhook. */
export interface Purchase {
  readonly at: number;
  readonly email: string | null;
  readonly orderId: string;
}

/** One daily retention pass per inbox, via Alchemy's scheduled events. */
const RETENTION_EVENT = "retention";
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Shown to someone redeeming an invite into a full inbox. */
const fullInboxMessage = (kind: CredentialKind, recipientName: string) =>
  kind === "sender"
    ? `${recipientName || "This inbox"} already has ${PAIRING_CAPS.sender} people who can send taps. Ask them to remove someone in the Mac app, then try this link again.`
    : `This inbox already has ${PAIRING_CAPS.device} devices. Remove one in the Mac app, then try again.`;

/** Shown to the recipient's Mac when it asks for an invite it can't use. */
const fullInviteMessage = (kind: CredentialKind) =>
  kind === "sender"
    ? `You already have ${PAIRING_CAPS.sender} people who can tap you. Remove someone before inviting someone new.`
    : `You already have ${PAIRING_CAPS.device} devices linked. Remove one before adding another.`;

/** Only senders carry a frame color; devices never do. */
const colorFor = (kind: CredentialKind, color: PersonColor | undefined) =>
  kind === "sender" ? (color ?? null) : null;

/** Only devices have a platform; one that doesn't say is a Mac (older apps). */
const platformFor = (
  kind: CredentialKind,
  platform: DevicePlatform | undefined
): DevicePlatform | null => (kind === "device" ? (platform ?? "mac") : null);

/** Why the last Mac can't go while an iPhone is still linked. */
const lastMacMessage =
  "This is the only Mac on this inbox, and taps show up on Macs. Add another Mac, or remove the linked iPhones first.";

type Rpc<A, E = never> = Effect.Effect<A, E, RuntimeContext>;

/** The Inbox's typed RPC surface, called by the Server Worker. */
export interface InboxRpc {
  readonly acknowledge: (
    token: ParsedToken,
    tapId: string,
    request: AcknowledgeRequest
  ) => Rpc<Tap, Unauthorized | NotFound | InvalidRequest>;
  /** Authorizes a paired Mac to start a checkout for this inbox. */
  readonly checkoutContext: (
    token: ParsedToken
  ) => Rpc<{ inboxId: string; recipientName: string }, Unauthorized | Conflict>;
  readonly createInvite: (
    token: ParsedToken,
    request: CreateInviteRequest
  ) => Rpc<Invite, Unauthorized | Conflict>;
  readonly createTicket: (
    token: ParsedToken
  ) => Rpc<ConnectTicket, Unauthorized>;
  /** Deletes only the authenticated sender and all of their taps/replies. */
  readonly deleteSender: (
    token: ParsedToken
  ) => Rpc<{ deleted: true }, Unauthorized>;
  /**
   * Creates the inbox. `trialEndsAt` comes from the Mac's trial ledger when
   * it has one; without it the trial is a fresh one from now.
   */
  readonly initialize: (
    inboxId: string,
    request: Omit<CreateInboxRequest, "machine">,
    trialEndsAt?: number
  ) => Rpc<CredentialGrant, Conflict>;
  readonly markDisplayed: (
    token: ParsedToken,
    tapId: string
  ) => Rpc<Tap, Unauthorized | NotFound>;
  /** Marks the inbox paid. Idempotent; false if it doesn't apply. */
  readonly recordPurchase: (purchase: Purchase) => Rpc<{ applied: boolean }>;
  /** Undoes the purchase with this order id, if it's the one on record. */
  readonly recordRefund: (orderId: string) => Rpc<{ applied: boolean }>;
  readonly redeemInvite: (
    code: ParsedToken,
    request: RedeemInviteRequest
  ) => Rpc<CredentialGrant, NotFound | Expired | Conflict>;
  readonly revoke: (
    token: ParsedToken,
    credentialId: string
  ) => Rpc<{ revoked: true }, Unauthorized | NotFound | Conflict>;
  readonly sendTap: (
    token: ParsedToken,
    request: SendTapRequest
  ) => Rpc<
    Tap,
    Unauthorized | Conflict | TooManyRequests | PaymentRequired | InvalidRequest
  >;
  readonly snapshot: (token: ParsedToken) => Rpc<Snapshot, Unauthorized>;
}

type InboxShape = InboxRpc &
  Required<
    Pick<
      Cloudflare.DurableObjectShape,
      "fetch" | "alarm" | "webSocketMessage" | "webSocketClose"
    >
  >;

/**
 * One instance per recipient, addressed by inbox id. The authoritative owner
 * of that recipient's paired Macs, trusted senders and taps. Commands arrive
 * as typed RPC from the Server Worker; events leave over hibernatable
 * WebSockets.
 */
export class Inbox extends Cloudflare.DurableObject<Inbox, InboxShape>()(
  "Inboxes",
  {
    // Revived as real instances on the Worker side of the RPC boundary.
    errors: [
      Unauthorized,
      NotFound,
      Conflict,
      Expired,
      InvalidRequest,
      TooManyRequests,
      PaymentRequired,
    ],
  }
) {}

/** Attached to each accepted socket; survives hibernation. */
const SocketSession = Schema.Struct({
  credentialId: Schema.String,
  kind: Schema.Literals(["device", "sender"]),
});
type SocketSession = typeof SocketSession.Type;
const decodeSession = Schema.decodeUnknownOption(SocketSession);

const now = Effect.sync(() => Date.now());

const randomId = (bytes = 12) =>
  Effect.sync(() =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );

const hashSecret = (secret: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret)
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });

/** Storage failures are defects: the Worker answers 500 and clients retry. */
const orDieOnStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (
        error
      ): error is Extract<
        E,
        { _tag: "EffectDrizzleQueryError" | "SqlError" }
      > =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error._tag === "EffectDrizzleQueryError" || error._tag === "SqlError"),
      (error) => Effect.die(error)
    )
  ) as Effect.Effect<
    A,
    Exclude<E, { _tag: "EffectDrizzleQueryError" | "SqlError" }>,
    R
  >;

/** A redeemable invite: it exists, the secret matches, unused and unexpired. */
const checkInvite = (
  invite: typeof invites.$inferSelect | undefined,
  secretHash: string,
  at: number
): Effect.Effect<typeof invites.$inferSelect, NotFound | Expired> => {
  if (!invite || invite.secretHash !== secretHash) {
    return Effect.fail(
      new NotFound({ message: "This invite link isn't valid" })
    );
  }
  if (invite.redeemedAt !== null) {
    return Effect.fail(
      new Expired({ message: "This invite link was already used" })
    );
  }
  if (invite.expiresAt < at) {
    return Effect.fail(
      new Expired({ message: "This invite link has expired" })
    );
  }
  return Effect.succeed(invite);
};

export const InboxLive = Inbox.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const db = yield* Drizzle.DurableObject({ migrations });
      // Keep-alive pings are answered without waking the object.
      yield* state.setWebSocketAutoResponse(
        // biome-ignore lint/correctness/noUndeclaredVariables: Workers runtime global
        new WebSocketRequestResponsePair("ping", "pong")
      );

      // Reads

      const tapRows = (
        where: Parameters<ReturnType<typeof selectTaps>["where"]>[0]
      ) =>
        selectTaps()
          .where(where)
          .orderBy(desc(taps.createdAt))
          .limit(HISTORY_LIMIT * 2);

      const selectTaps = () =>
        db
          .select({
            tap: taps,
            senderName: credentials.name,
            senderColor: credentials.color,
          })
          .from(taps)
          .innerJoin(credentials, eq(credentials.id, taps.senderId));

      const toTap = ({
        tap,
        senderName,
        senderColor,
      }: {
        tap: typeof taps.$inferSelect;
        senderName: string;
        senderColor: typeof credentials.$inferSelect.color;
      }): Tap => ({
        id: tap.id,
        senderId: tap.senderId,
        senderName,
        senderColor: senderColor ?? fallbackColor(tap.senderId),
        body: tap.body,
        createdAt: tap.createdAt,
        state: tap.state,
        displayedAt: tap.displayedAt,
        acknowledgedAt: tap.acknowledgedAt,
        acknowledgedBy: tap.acknowledgedBy,
        response: tap.response,
        sequence: tap.sequence,
      });

      const getTap = (tapId: string) =>
        tapRows(eq(taps.id, tapId)).pipe(
          Effect.flatMap(([row]) =>
            row
              ? Effect.succeed(toTap(row))
              : Effect.fail(new NotFound({ message: "No such tap" }))
          )
        );

      const inboxRow = db
        .select()
        .from(inbox)
        .where(eq(inbox.id, 1))
        .pipe(Effect.map(([row]) => row));

      const listCredentials = db
        .select()
        .from(credentials)
        .where(isNull(credentials.revokedAt))
        .orderBy(credentials.createdAt)
        .pipe(
          Effect.map((rows) =>
            rows.map(
              (row): Credential => ({
                id: row.id,
                kind: row.kind,
                name: row.name,
                color:
                  row.kind === "sender"
                    ? (row.color ?? fallbackColor(row.id))
                    : null,
                platform: platformFor(row.kind, row.platform ?? undefined),
                createdAt: row.createdAt,
                lastSeenAt: row.lastSeenAt,
              })
            )
          )
        );

      const authenticate = Effect.fn("Inbox.authenticate")(function* (
        token: ParsedToken
      ) {
        const secretHash = yield* hashSecret(token.secret);
        const [row] = yield* db
          .select()
          .from(credentials)
          .where(
            and(eq(credentials.id, token.id), isNull(credentials.revokedAt))
          );
        if (!row || row.secretHash !== secretHash) {
          return yield* new Unauthorized({
            message: "This pairing is no longer valid",
          });
        }
        const at = yield* now;
        if ((row.lastSeenAt ?? 0) < at - LAST_SEEN_WRITE_INTERVAL_MS) {
          yield* db
            .update(credentials)
            .set({ lastSeenAt: at })
            .where(eq(credentials.id, row.id));
        }
        return row;
      });

      const requireKind = (kind: CredentialKind, message: string) =>
        Effect.fn(function* (token: ParsedToken) {
          const actor = yield* authenticate(token);
          if (actor.kind !== kind) {
            return yield* new Unauthorized({ message });
          }
          return actor;
        });
      const requireDevice = requireKind(
        "device",
        "Only your linked devices can do that"
      );
      const requireSender = requireKind(
        "sender",
        "Only a paired sender can send taps"
      );

      // Events

      const sessions = Effect.gen(function* () {
        const sockets = yield* state.getWebSockets();
        return sockets.flatMap((socket) => {
          const session = decodeSession(socket.deserializeAttachment());
          return session._tag === "Some"
            ? [{ socket, session: session.value }]
            : [];
        });
      });

      const send = (socket: Cloudflare.WebSocket, event: ServerEvent) =>
        // A dead socket is cleaned up by the runtime; clients resync on reconnect.
        socket.send(JSON.stringify(event)).pipe(Effect.ignore);

      const broadcast = (
        event: ServerEvent,
        to: (session: SocketSession) => boolean
      ) =>
        Effect.gen(function* () {
          for (const { socket, session } of yield* sessions) {
            if (to(session)) {
              yield* send(socket, event);
            }
          }
        });

      const broadcastTap = (tap: Tap) =>
        broadcast(
          { v: 1, type: "tap", sequence: tap.sequence, tap },
          (session) =>
            session.kind === "device" || session.credentialId === tap.senderId
        );

      const broadcastCredentials = inboxRow.pipe(
        Effect.flatMap((row) =>
          broadcast(
            { v: 1, type: "credentials", sequence: row?.sequence ?? 0 },
            (session) => session.kind === "device"
          )
        )
      );

      const nextSequence = db
        .update(inbox)
        .set({ sequence: sql`${inbox.sequence} + 1` })
        .where(eq(inbox.id, 1))
        .returning({ sequence: inbox.sequence })
        .pipe(Effect.map(([row]) => row?.sequence ?? 0));

      const issueCredential = Effect.fn(function* (
        kind: CredentialKind,
        name: string
      ) {
        const id = yield* randomId();
        const secret = yield* randomId(32);
        const secretHash = yield* hashSecret(secret);
        const createdAt = yield* now;
        return { row: { id, kind, name, secretHash, createdAt }, secret };
      });

      /** Active (non-revoked) pairings of one kind. */
      const isActive = (kind: CredentialKind) =>
        and(eq(credentials.kind, kind), isNull(credentials.revokedAt));

      // Retention: one repeating event in Alchemy's DO scheduler drives the
      // alarm. Armed when the inbox is created, and on every activation of
      // an existing inbox, so inboxes created before retention get one too.
      const withState = Effect.provideService(
        Cloudflare.DurableObjectState,
        state
      );

      const ensureRetention = Effect.gen(function* () {
        const events = yield* Cloudflare.Workers.listEvents;
        if (events.some((event) => event.id === RETENTION_EVENT)) {
          return;
        }
        const at = yield* now;
        yield* Cloudflare.Workers.scheduleEvent(
          RETENTION_EVENT,
          new Date(at + RETENTION_INTERVAL_MS),
          {},
          RETENTION_INTERVAL_MS
        );
      }).pipe(withState);

      const pruneExpired = Effect.gen(function* () {
        const filters = retentionFilters(yield* now);
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(taps).where(filters.taps);
            yield* tx.delete(invites).where(filters.invites);
            yield* tx.delete(tickets).where(filters.tickets);
            yield* tx.delete(credentials).where(filters.revokedCredentials);
          })
        );
      });

      if (yield* inboxRow.pipe(Effect.orDie)) {
        yield* ensureRetention;
      }

      const rpc: InboxRpc = {
        initialize: Effect.fn("Inbox.initialize")(function* (
          inboxId,
          request,
          trialEndsAt
        ) {
          const existing = yield* inboxRow;
          if (existing) {
            return yield* new Conflict({ message: "Inbox already exists" });
          }
          const credential = yield* issueCredential(
            "device",
            request.deviceName
          );
          const createdAt = yield* now;
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(inbox).values({
                id: 1,
                inboxId,
                recipientName: request.recipientName,
                trialEndsAt: trialEndsAt ?? createdAt + TRIAL_MS,
              });
              yield* tx
                .insert(credentials)
                .values({ ...credential.row, platform: "mac" });
            })
          );
          yield* ensureRetention;
          return {
            kind: "device" as const,
            credentialId: credential.row.id,
            token: formatToken({
              inboxId,
              id: credential.row.id,
              secret: credential.secret,
            }),
            recipientName: request.recipientName,
          };
        }, orDieOnStorage),

        snapshot: Effect.fn("Inbox.snapshot")(function* (token) {
          const actor = yield* authenticate(token);
          const row = yield* inboxRow;
          const recipientName = row?.recipientName ?? "";
          const sequence = row?.sequence ?? 0;
          if (actor.kind === "sender") {
            const rows = yield* tapRows(eq(taps.senderId, actor.id));
            return {
              kind: "sender" as const,
              credentialId: actor.id,
              senderName: actor.name,
              senderColor: actor.color ?? fallbackColor(actor.id),
              recipientName,
              sequence,
              taps: rows.map(toTap),
            };
          }
          const pending = yield* tapRows(eq(taps.state, "pending"));
          const recent = yield* selectTaps()
            .orderBy(desc(taps.createdAt))
            .limit(HISTORY_LIMIT);
          const byId = new Map(
            [...recent, ...pending].map((r) => [r.tap.id, toTap(r)])
          );
          return {
            kind: "device" as const,
            credentialId: actor.id,
            recipientName,
            sequence,
            taps: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt),
            credentials: yield* listCredentials,
            plan: planOf(row, yield* now),
          };
        }, orDieOnStorage),

        createInvite: Effect.fn("Inbox.createInvite")(function* (
          token,
          request
        ) {
          const actor = yield* requireDevice(token);
          // Refuse early; redeeming re-checks, since pairings change meanwhile.
          const [active] = yield* db
            .select({ n: count() })
            .from(credentials)
            .where(isActive(request.kind));
          if ((active?.n ?? 0) >= PAIRING_CAPS[request.kind]) {
            return yield* new Conflict({
              message: fullInviteMessage(request.kind),
            });
          }
          const id = yield* randomId();
          const secret = yield* randomId(24);
          const createdAt = yield* now;
          const expiresAt =
            createdAt +
            (request.kind === "sender"
              ? SENDER_INVITE_TTL_MS
              : DEVICE_INVITE_TTL_MS);
          yield* db.insert(invites).values({
            id,
            kind: request.kind,
            secretHash: yield* hashSecret(secret),
            createdBy: actor.id,
            createdAt,
            expiresAt,
          });
          return {
            kind: request.kind,
            code: formatToken({ inboxId: token.inboxId, id, secret }),
            expiresAt,
          };
        }, orDieOnStorage),

        redeemInvite: Effect.fn("Inbox.redeemInvite")(function* (
          code,
          request
        ) {
          const secretHash = yield* hashSecret(code.secret);
          const credential = yield* issueCredential("sender", request.name);
          const at = yield* now;
          const grant = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const [invite] = yield* tx
                .select()
                .from(invites)
                .where(eq(invites.id, code.id));
              const { kind } = yield* checkInvite(invite, secretHash, at);
              const [inboxState] = yield* tx
                .select()
                .from(inbox)
                .where(eq(inbox.id, 1));
              const recipientName = inboxState?.recipientName ?? "";
              // Checked before consuming the invite, so the same link works
              // once the recipient makes room.
              const [active] = yield* tx
                .select({ n: count() })
                .from(credentials)
                .where(isActive(kind));
              if ((active?.n ?? 0) >= PAIRING_CAPS[kind]) {
                return yield* new Conflict({
                  message: fullInboxMessage(kind, recipientName),
                });
              }
              yield* tx
                .update(invites)
                .set({ redeemedAt: at })
                .where(eq(invites.id, code.id));
              yield* tx.insert(credentials).values({
                ...credential.row,
                kind,
                color: colorFor(kind, request.color),
                platform: platformFor(kind, request.platform),
              });
              return {
                kind,
                credentialId: credential.row.id,
                token: formatToken({
                  inboxId: code.inboxId,
                  id: credential.row.id,
                  secret: credential.secret,
                }),
                recipientName,
              };
            })
          );
          yield* broadcastCredentials;
          return grant;
        }, orDieOnStorage),

        sendTap: Effect.fn("Inbox.sendTap")(function* (token, request) {
          const actor = yield* requireSender(token);
          if (isObjectionable(request.body)) {
            return yield* new InvalidRequest({
              message:
                "This message contains threatening or abusive language. Please rewrite it.",
            });
          }
          const id = yield* randomId();
          const createdAt = yield* now;
          const tapId = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const [existing] = yield* tx
                .select()
                .from(taps)
                .where(
                  and(
                    eq(taps.senderId, actor.id),
                    eq(taps.requestId, request.requestId)
                  )
                );
              if (existing) {
                // Idempotent retry: same request id, same message → same tap.
                if (existing.body !== request.body) {
                  return yield* new Conflict({
                    message: "Request id was reused with a different message",
                  });
                }
                return { id: existing.id, isNew: false };
              }
              // A paused inbox refuses new taps; retries above still resolve.
              const [plan] = yield* tx
                .select()
                .from(inbox)
                .where(eq(inbox.id, 1));
              yield* requireActivePlan(plan, createdAt);
              const [recent] = yield* tx
                .select({ n: count() })
                .from(taps)
                .where(
                  and(
                    eq(taps.senderId, actor.id),
                    gt(taps.createdAt, createdAt - HOUR_MS)
                  )
                );
              if ((recent?.n ?? 0) >= TAPS_PER_HOUR) {
                return yield* new TooManyRequests({
                  message:
                    "You've sent a lot of taps this hour. Try again later.",
                });
              }
              const [row] = yield* tx
                .update(inbox)
                .set({ sequence: sql`${inbox.sequence} + 1` })
                .where(eq(inbox.id, 1))
                .returning({ sequence: inbox.sequence });
              yield* tx.insert(taps).values({
                id,
                requestId: request.requestId,
                senderId: actor.id,
                body: request.body,
                createdAt,
                state: "pending",
                sequence: row?.sequence ?? 0,
              });
              return { id, isNew: true };
            })
          );
          const tap = yield* getTap(tapId.id).pipe(Effect.orDie);
          if (tapId.isNew) {
            yield* broadcastTap(tap);
          }
          return tap;
        }, orDieOnStorage),

        markDisplayed: Effect.fn("Inbox.markDisplayed")(function* (
          token,
          tapId
        ) {
          yield* requireDevice(token);
          const tap = yield* getTap(tapId);
          if (tap.displayedAt !== null) {
            return tap;
          }
          const at = yield* now;
          const sequence = yield* nextSequence;
          yield* db
            .update(taps)
            .set({ displayedAt: at, sequence })
            .where(eq(taps.id, tapId));
          const updated = yield* getTap(tapId);
          yield* broadcastTap(updated);
          return updated;
        }, orDieOnStorage),

        acknowledge: Effect.fn("Inbox.acknowledge")(function* (
          token,
          tapId,
          request
        ) {
          const actor = yield* requireDevice(token);
          if (request.response.text && isObjectionable(request.response.text)) {
            return yield* new InvalidRequest({
              message:
                "This reply contains threatening or abusive language. Please rewrite it.",
            });
          }
          if (
            request.response.kind === "text" &&
            !request.response.text?.trim()
          ) {
            return yield* new InvalidRequest({
              message: "A text reply needs some text",
            });
          }
          const at = yield* now;
          // First committed acknowledgement wins; retries and other Macs get it back.
          const changed = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [row] = yield* tx
                  .update(inbox)
                  .set({ sequence: sql`${inbox.sequence} + 1` })
                  .where(eq(inbox.id, 1))
                  .returning({ sequence: inbox.sequence });
                const updated = yield* tx
                  .update(taps)
                  .set({
                    state: "acknowledged",
                    acknowledgedAt: at,
                    acknowledgedBy: actor.name,
                    displayedAt: sql`COALESCE(${taps.displayedAt}, ${at})`,
                    response: request.response,
                    sequence: row?.sequence ?? 0,
                  })
                  .where(and(eq(taps.id, tapId), eq(taps.state, "pending")))
                  .returning({ id: taps.id });
                if (updated.length === 0) {
                  yield* tx.rollback();
                }
                return updated.length > 0;
              })
            )
            .pipe(
              Effect.catchTag("EffectTransactionRollbackError", () =>
                Effect.succeed(false)
              )
            );
          const tap = yield* getTap(tapId);
          if (changed) {
            yield* broadcastTap(tap);
          }
          return tap;
        }, orDieOnStorage),

        revoke: Effect.fn("Inbox.revoke")(function* (token, credentialId) {
          // A device can remove anyone; a sender can only unpair itself.
          const actor = yield* authenticate(token);
          if (actor.kind === "sender" && actor.id !== credentialId) {
            return yield* new Unauthorized({
              message: "A sender can only unpair itself",
            });
          }
          const at = yield* now;
          const revoked = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const devices = yield* tx
                .select({ id: credentials.id, platform: credentials.platform })
                .from(credentials)
                .where(isActive("device"));
              const target = devices.find(
                (device) => device.id === credentialId
              );
              // Macs are where taps show up: an inbox left with only iPhones
              // would take taps that nothing displays. Removing the very last
              // device (resetting the inbox) is still allowed.
              if (
                target &&
                platformFor("device", target.platform ?? undefined) === "mac"
              ) {
                const rest = devices.filter(
                  (device) => device.id !== credentialId
                );
                const macsLeft = rest.filter(
                  (device) =>
                    platformFor("device", device.platform ?? undefined) ===
                    "mac"
                );
                if (rest.length > 0 && macsLeft.length === 0) {
                  return yield* new Conflict({ message: lastMacMessage });
                }
              }
              return yield* tx
                .update(credentials)
                .set({ revokedAt: at })
                .where(
                  and(
                    eq(credentials.id, credentialId),
                    isNull(credentials.revokedAt)
                  )
                )
                .returning({ id: credentials.id });
            })
          );
          if (revoked.length === 0) {
            return yield* new NotFound({ message: "No such pairing" });
          }
          for (const { socket, session } of yield* sessions) {
            if (session.credentialId === credentialId) {
              yield* send(socket, { v: 1, type: "revoked" });
              yield* socket.close(4001, "revoked");
            }
          }
          yield* broadcastCredentials;
          return { revoked: true as const };
        }, orDieOnStorage),

        deleteSender: Effect.fn("Inbox.deleteSender")(function* (token) {
          const actor = yield* requireSender(token);
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.delete(taps).where(eq(taps.senderId, actor.id));
              yield* tx
                .delete(tickets)
                .where(eq(tickets.credentialId, actor.id));
              yield* tx.delete(invites).where(eq(invites.createdBy, actor.id));
              yield* tx.delete(credentials).where(eq(credentials.id, actor.id));
            })
          );
          for (const { socket, session } of yield* sessions) {
            if (session.credentialId === actor.id) {
              yield* send(socket, { v: 1, type: "revoked" });
              yield* socket.close(4001, "deleted");
            }
          }
          yield* broadcastCredentials;
          return { deleted: true as const };
        }, orDieOnStorage),

        checkoutContext: Effect.fn("Inbox.checkoutContext")(function* (token) {
          yield* requireDevice(token);
          const row = yield* inboxRow;
          if ((row?.paidAt ?? null) !== null) {
            return yield* new Conflict({
              message: "Shouldertap is already unlocked for this inbox.",
            });
          }
          return {
            inboxId: token.inboxId,
            recipientName: row?.recipientName ?? "",
          };
        }, orDieOnStorage),

        recordPurchase: Effect.fn("Inbox.recordPurchase")(function* (purchase) {
          // Webhooks retry and can repeat: only an unpaid inbox, or the same
          // order again, is updated. A second purchase keeps the first.
          const updated = yield* db
            .update(inbox)
            .set({
              paidAt: purchase.at,
              orderId: purchase.orderId,
              purchaseEmail: purchase.email,
            })
            .where(
              and(
                eq(inbox.id, 1),
                sql`(${inbox.paidAt} IS NULL OR ${inbox.orderId} = ${purchase.orderId})`
              )
            )
            .returning({ id: inbox.id });
          if (updated.length > 0) {
            yield* broadcastCredentials;
          }
          return { applied: updated.length > 0 };
        }, orDieOnStorage),

        recordRefund: Effect.fn("Inbox.recordRefund")(function* (orderId) {
          const updated = yield* db
            .update(inbox)
            .set({ paidAt: null })
            .where(and(eq(inbox.id, 1), eq(inbox.orderId, orderId)))
            .returning({ id: inbox.id });
          if (updated.length > 0) {
            yield* broadcastCredentials;
          }
          return { applied: updated.length > 0 };
        }, orDieOnStorage),

        createTicket: Effect.fn("Inbox.createTicket")(function* (token) {
          const actor = yield* authenticate(token);
          const id = yield* randomId();
          const secret = yield* randomId(24);
          const at = yield* now;
          const expiresAt = at + TICKET_TTL_MS;
          yield* db.delete(tickets).where(lt(tickets.expiresAt, at));
          yield* db.insert(tickets).values({
            id,
            secretHash: yield* hashSecret(secret),
            credentialId: actor.id,
            expiresAt,
          });
          return {
            ticket: formatToken({ inboxId: token.inboxId, id, secret }),
            expiresAt,
          };
        }, orDieOnStorage),
      };

      const unauthorized = (message: string) =>
        HttpServerResponse.text(message, { status: 401 });

      return {
        ...rpc,

        // `GET /v1/connect?ticket=…`, forwarded by the Worker.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const query = request.url.includes("?")
            ? request.url.slice(request.url.indexOf("?") + 1)
            : "";
          const ticket = parseToken(
            new URLSearchParams(query).get("ticket") ?? ""
          );
          if (!ticket) {
            return unauthorized("Invalid ticket");
          }
          const secretHash = yield* hashSecret(ticket.secret);
          // One-time: consume before checking.
          const [row] = yield* db
            .delete(tickets)
            .where(eq(tickets.id, ticket.id))
            .returning();
          if (
            !row ||
            row.secretHash !== secretHash ||
            row.expiresAt < (yield* now)
          ) {
            return unauthorized("Invalid ticket");
          }
          const [credential] = yield* db
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.id, row.credentialId),
                isNull(credentials.revokedAt)
              )
            );
          if (!credential) {
            return unauthorized("Revoked");
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          socket.serializeAttachment({
            credentialId: credential.id,
            kind: credential.kind,
          } satisfies SocketSession);
          return response;
        }).pipe(Effect.orDie),

        alarm: () =>
          Effect.gen(function* () {
            if (!(yield* inboxRow)) {
              // Never initialized: nothing to keep, so stop the schedule.
              return yield* Cloudflare.Workers.cancelEvent(RETENTION_EVENT);
            }
            // Prune before advancing the schedule: if this fails, the alarm
            // is retried with the event still due.
            yield* pruneExpired;
            yield* Cloudflare.Workers.processScheduledEvents;
          }).pipe(withState, Effect.orDie),

        // Clients send commands over HTTPS; "ping" is handled by the auto-response.
        webSocketMessage: () => Effect.void,

        webSocketClose: (socket, code, reason) =>
          socket.close(code === 1005 ? 1000 : code, reason),
      };
    });
  })
);
