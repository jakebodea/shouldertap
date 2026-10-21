import { Conflict, Expired, NotFound, Unauthorized } from "@shouldertap/domain";
import type { ParsedPatronKey, Patron } from "@shouldertap/domain";
import { and, count, eq, isNull, lt } from "drizzle-orm";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

import { patronOf } from "./patron";
import {
  patron,
  patronEvents,
  patronKeys,
  patronLinkCodes,
} from "./patron-schema";
import { hashSecret } from "./secrets";

/**
 * A sender's patron identity: the billing subject for sender themes. It is
 * deliberately not a recipient inbox and not a pairing credential. Its keys
 * are random bearer secrets held by the sender's own browsers and apps; only
 * their hashes are stored. Possession of a key is what proves membership, so
 * a buyer's email, a customer or subscription id, or a forwarded pairing link
 * proves nothing. These functions run inside the Patron Durable Object (and
 * against real SQLite in tests).
 */

/** Keys one identity may hold: the sender's phones and browsers. */
export const PATRON_KEY_CAP = 10;
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

export interface NewSecret {
  readonly id: string;
  readonly secretHash: string;
}

const activeKeys = (db: EffectSQLiteDoDatabase) =>
  db
    .select({ n: count() })
    .from(patronKeys)
    .where(isNull(patronKeys.revokedAt))
    .pipe(Effect.map(([row]) => row?.n ?? 0));

/** Creates the identity with its first key. Conflict if it already exists. */
export const createIdentity = Effect.fn(function* createIdentity(
  db: EffectSQLiteDoDatabase,
  patronId: string,
  key: NewSecret,
  at: number
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* create() {
      const [existing] = yield* tx.select().from(patron);
      if (existing) {
        return yield* new Conflict({ message: "Patron already exists" });
      }
      yield* tx.insert(patron).values({ id: 1, patronId, createdAt: at });
      yield* tx
        .insert(patronKeys)
        .values({ id: key.id, secretHash: key.secretHash, createdAt: at });
    })
  );
});

/** The live key with this id and secret hash, or Unauthorized. */
export const authenticateKey = Effect.fn(function* authenticateKey(
  db: EffectSQLiteDoDatabase,
  keyId: string,
  secretHash: string,
  at: number
) {
  const [row] = yield* db
    .select()
    .from(patronKeys)
    .where(and(eq(patronKeys.id, keyId), isNull(patronKeys.revokedAt)));
  if (!row || row.secretHash !== secretHash) {
    return yield* new Unauthorized({
      message: "This patron key is no longer valid",
    });
  }
  if ((row.lastSeenAt ?? 0) < at - LAST_SEEN_WRITE_INTERVAL_MS) {
    yield* db
      .update(patronKeys)
      .set({ lastSeenAt: at })
      .where(eq(patronKeys.id, row.id));
  }
  return row;
});

/** Membership now, folded from this identity's own signed facts. */
export const membershipOf = Effect.fn(function* membershipOf(
  db: EffectSQLiteDoDatabase,
  at: number
) {
  const events = (yield* db.select().from(patronEvents)).map((r) => r.event);
  return patronOf(events, at);
});

/** Whether a presented key belongs to this identity while it's an active
 * patron: what lets a send carry a theme. Unauthorized for a wrong key. */
export const isActiveKey = Effect.fn(function* isActiveKey(
  db: EffectSQLiteDoDatabase,
  key: ParsedPatronKey,
  at: number
) {
  yield* authenticateKey(db, key.keyId, yield* hashSecret(key.secret), at);
  return (yield* membershipOf(db, at)).active;
});

export const statusOf = Effect.fn(function* statusOf(
  db: EffectSQLiteDoDatabase,
  at: number
) {
  const [row] = yield* db.select().from(patron);
  const membership: Patron = yield* membershipOf(db, at);
  return {
    patronId: row?.patronId ?? "",
    patron: membership,
    keys: yield* activeKeys(db),
  };
});

/** A one-time code that adds another of the sender's devices. */
export const createLinkCode = Effect.fn(function* createLinkCode(
  db: EffectSQLiteDoDatabase,
  createdBy: string,
  code: NewSecret,
  at: number
) {
  if ((yield* activeKeys(db)) >= PATRON_KEY_CAP) {
    return yield* new Conflict({
      message: `This membership is already on ${PATRON_KEY_CAP} devices. Forget one before adding another.`,
    });
  }
  yield* db.delete(patronLinkCodes).where(lt(patronLinkCodes.expiresAt, at));
  const expiresAt = at + LINK_CODE_TTL_MS;
  yield* db.insert(patronLinkCodes).values({
    id: code.id,
    secretHash: code.secretHash,
    createdBy,
    createdAt: at,
    expiresAt,
  });
  return { expiresAt };
});

/** Consumes a link code and adds a key, atomically. */
export const redeemLinkCode = Effect.fn(function* redeemLinkCode(
  db: EffectSQLiteDoDatabase,
  codeId: string,
  codeSecretHash: string,
  key: NewSecret,
  at: number
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* redeem() {
      const [code] = yield* tx
        .select()
        .from(patronLinkCodes)
        .where(eq(patronLinkCodes.id, codeId));
      if (!code || code.secretHash !== codeSecretHash) {
        return yield* new NotFound({ message: "This code isn't valid" });
      }
      if (code.redeemedAt !== null) {
        return yield* new Expired({ message: "This code was already used" });
      }
      if (code.expiresAt <= at) {
        return yield* new Expired({ message: "This code has expired" });
      }
      const [creator] = yield* tx
        .select()
        .from(patronKeys)
        .where(
          and(eq(patronKeys.id, code.createdBy), isNull(patronKeys.revokedAt))
        );
      if (!creator) {
        return yield* new Expired({
          message: "The device that made this code was forgotten",
        });
      }
      const [active] = yield* tx
        .select({ n: count() })
        .from(patronKeys)
        .where(isNull(patronKeys.revokedAt));
      if ((active?.n ?? 0) >= PATRON_KEY_CAP) {
        return yield* new Conflict({
          message: `This membership is already on ${PATRON_KEY_CAP} devices.`,
        });
      }
      yield* tx
        .update(patronLinkCodes)
        .set({ redeemedAt: at })
        .where(eq(patronLinkCodes.id, codeId));
      yield* tx
        .insert(patronKeys)
        .values({ id: key.id, secretHash: key.secretHash, createdAt: at });
      const [row] = yield* tx.select().from(patron);
      return { patronId: row?.patronId ?? "" };
    })
  );
});

export const revokeKey = (
  db: EffectSQLiteDoDatabase,
  keyId: string,
  at: number
) =>
  db
    .update(patronKeys)
    .set({ revokedAt: at })
    .where(and(eq(patronKeys.id, keyId), isNull(patronKeys.revokedAt)));
