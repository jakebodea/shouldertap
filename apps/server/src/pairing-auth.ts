import { Unauthorized, Conflict } from "@shouldertap/domain";
import type { ParsedToken, CredentialKind } from "@shouldertap/domain";
import { and, count, eq, isNull, or, sql } from "drizzle-orm";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

import { credentials } from "./schema";
import { hashSecret } from "./secrets";

/** An account-restored sender key authenticates as its existing pairing. Both
 * the individual key and canonical pairing must remain live. */
export const authenticatePairing = Effect.fn(function* authenticatePairing(
  db: EffectSQLiteDoDatabase,
  token: ParsedToken,
  at: number
) {
  const secretHash = yield* hashSecret(token.secret);
  let [row] = yield* db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.id, token.id),
        isNull(credentials.revokedAt),
        isNull(credentials.keyRevokedAt)
      )
    );
  if (!row || row.secretHash !== secretHash) {
    return yield* new Unauthorized({
      message: "This pairing is no longer valid",
    });
  }
  if (row.parentId) {
    [row] = yield* db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.id, row.parentId), isNull(credentials.revokedAt))
      );
    if (!row || row.kind !== "sender" || row.parentId) {
      return yield* new Unauthorized({
        message: "This pairing is no longer valid",
      });
    }
  }
  if ((row.lastSeenAt ?? 0) < at - 60_000) {
    yield* db
      .update(credentials)
      .set({ lastSeenAt: at })
      .where(eq(credentials.id, row.id));
  }
  return row;
});

/** Unpairing a sender device must never remove its other devices. Recipient
 * devices retain their authority to remove the complete trusted sender. */
export const authorizePairingRevocation = (
  kind: "sender" | "device",
  presentedKeyId: string,
  targetId: string
) =>
  kind === "sender" && presentedKeyId !== targetId
    ? Effect.fail(
        new Unauthorized({ message: "A sender can only unpair this device" })
      )
    : Effect.succeed(targetId);

/** A canonical sender is connected only while at least one of its device keys
 * can authenticate. Keep dormant identities for recovery, without listing or
 * counting them as connected people. The same predicate drives both surfaces. */
export const connectedPairingCondition = (kind?: CredentialKind) =>
  and(
    isNull(credentials.parentId),
    isNull(credentials.revokedAt),
    kind ? eq(credentials.kind, kind) : undefined,
    or(
      isNull(credentials.keyRevokedAt),
      and(
        eq(credentials.kind, "sender"),
        sql`EXISTS (
      SELECT 1 FROM credentials AS active_key
      WHERE active_key.parent_id = ${credentials.id}
        AND active_key.revoked_at IS NULL
        AND active_key.key_revoked_at IS NULL
    )`
      )
    )
  );

export const connectedPairings = (db: EffectSQLiteDoDatabase) =>
  db
    .select()
    .from(credentials)
    .where(connectedPairingCondition())
    .orderBy(credentials.createdAt);

/** Restoring a dormant sender consumes a person slot just as invite redemption
 * does; adding a key to an already connected person consumes no extra slot. */
export const requireSenderRestoreRoom = Effect.fn(
  function* requireSenderRestoreRoom(
    db: EffectSQLiteDoDatabase,
    senderId: string,
    cap: number
  ) {
    const [connected] = yield* db
      .select({ n: count() })
      .from(credentials)
      .where(
        and(connectedPairingCondition("sender"), eq(credentials.id, senderId))
      );
    if ((connected?.n ?? 0) > 0) {
      return senderId;
    }
    const [people] = yield* db
      .select({ n: count() })
      .from(credentials)
      .where(connectedPairingCondition("sender"));
    if ((people?.n ?? 0) >= cap) {
      return yield* new Conflict({
        message:
          "This inbox is full. Remove a person before restoring this connection.",
      });
    }
    return senderId;
  }
);
