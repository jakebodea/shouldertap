import { Unauthorized } from "@shouldertap/domain";
import type { ParsedToken } from "@shouldertap/domain";
import { and, eq, isNull } from "drizzle-orm";
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
