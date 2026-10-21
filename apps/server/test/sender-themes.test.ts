import { formatPatronKey } from "@shouldertap/domain";
import type { TapTheme } from "@shouldertap/domain";
import { eq } from "drizzle-orm";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { PatronEvent } from "../src/patron";
import {
  authenticateKey,
  createIdentity,
  createLinkCode,
  isActiveKey,
  redeemLinkCode,
  revokeKey,
  statusOf,
} from "../src/patron-identity";
import { storePatronEvent } from "../src/patron-storage";
import { themeForSend } from "../src/presentation";
import { taps } from "../src/schema";
import { hashSecret } from "../src/secrets";
import { readTaps, storeTap } from "../src/tap-storage";
import { migrate, open, withFile } from "./do-sqlite";

// Frozen clock: October 21, 2026, a year of support paid through October 21,
// 2027 (UTC).
const NOW = Date.UTC(2026, 9, 21);
const PAID_UNTIL = Date.UTC(2027, 9, 21);
const AFTER_LAPSE = Date.UTC(2027, 9, 22);

const paid: PatronEvent = {
  id: "evt_paid",
  at: NOW,
  type: "subscription.paid",
  subscriptionId: "sub_1",
  customerId: "cust_1",
  periodEnd: PAID_UNTIL,
  transactionId: "tran_1",
  refundTransactionId: null,
};
const refund: PatronEvent = {
  ...paid,
  id: "evt_refund",
  at: NOW + 60_000,
  type: "refund.created",
  refundTransactionId: "tran_1",
};

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.scoped(effect));

/** A sender's patron identity in its own database, with one key. */
const KEY = {
  patronId: "patronAAAA",
  keyId: "keyAAAAAA",
  secret: "secret-AAAAAAAA",
};
const patronDb = async (path: string, events: PatronEvent[] = []) => {
  const handle = open(`${path}.patron`);
  migrate(handle.sqlite, { folder: "drizzle-patron" });
  await run(
    Effect.gen(function* setup() {
      const db = yield* handle.db;
      yield* createIdentity(
        db,
        KEY.patronId,
        { id: KEY.keyId, secretHash: yield* hashSecret(KEY.secret) },
        NOW - 1000
      );
      for (const event of events) {
        yield* storePatronEvent(db, event);
      }
    })
  );
  return handle;
};

/** A recipient inbox with senders already paired. */
const inboxDb = (path: string, name: string, senders: string[]) => {
  const handle = open(`${path}.${name}`);
  migrate(handle.sqlite);
  handle.sqlite
    .prepare(
      `INSERT INTO inbox (id, inbox_id, recipient_name) VALUES (1, '${name}', '${name}')`
    )
    .run();
  for (const id of senders) {
    handle.sqlite
      .prepare(
        `INSERT INTO credentials (id, kind, name, color, secret_hash, created_at) VALUES ('${id}', 'sender', '${id}', 'moss', 'x', 0)`
      )
      .run();
  }
  return handle;
};

/** One send, end to end the way the Worker and Inbox do it. */
const send = (
  inbox: Effect.Effect<EffectSQLiteDoDatabase, never, never>,
  patron: Effect.Effect<EffectSQLiteDoDatabase, never, never> | null,
  {
    senderId,
    requestId,
    body,
    theme,
    patronKey,
    at,
  }: {
    senderId: string;
    requestId: string;
    body: string;
    theme?: TapTheme;
    patronKey?: string;
    at: number;
  }
) =>
  Effect.gen(function* sendTap() {
    const verified = yield* themeForSend(theme, patronKey, (key) =>
      patron
        ? patron.pipe(Effect.flatMap((db) => isActiveKey(db, key, at)))
        : Effect.succeed(false)
    );
    const db = yield* inbox;
    yield* storeTap(db, {
      senderId,
      message: { requestId, body },
      theme: verified,
      id: requestId,
      at,
    });
    const [tap] = yield* readTaps(db, eq(taps.requestId, requestId), 1);
    return tap?.theme;
  });

const KEY_STRING = formatPatronKey(KEY);

describe("sender patron identity", () => {
  it("is proved only by its key; a wrong secret, another key id or a revoked key gets nothing", () =>
    withFile(async (path) => {
      const patron = await patronDb(path, [paid]);
      try {
        const result = await run(
          Effect.gen(function* auth() {
            const db = yield* patron.db;
            const right = yield* isActiveKey(db, KEY, NOW);
            const wrongSecret = yield* isActiveKey(
              db,
              {
                ...KEY,
                secret: "guessed-secret",
              },
              NOW
            ).pipe(Effect.flip);
            // Knowing the customer or subscription id is no key at all.
            const customerAsKey = yield* isActiveKey(
              db,
              {
                ...KEY,
                keyId: "cust_1",
              },
              NOW
            ).pipe(Effect.flip);
            yield* revokeKey(db, KEY.keyId, NOW);
            const revoked = yield* isActiveKey(db, KEY, NOW).pipe(Effect.flip);
            return {
              right,
              wrongSecret: wrongSecret.message,
              customerAsKey: customerAsKey._tag,
              revoked: revoked._tag,
            };
          })
        );
        expect(result).toStrictEqual({
          right: true,
          wrongSecret: "This patron key is no longer valid",
          customerAsKey: "Unauthorized",
          revoked: "Unauthorized",
        });
      } finally {
        patron.sqlite.close();
      }
    }));

  it("adds the sender's other device with a one-time, 15-minute link code", () =>
    withFile(async (path) => {
      const patron = await patronDb(path, [paid]);
      try {
        const result = await run(
          Effect.gen(function* link() {
            const db = yield* patron.db;
            const code = {
              id: "codeAAAAA",
              secretHash: yield* hashSecret("code-secret"),
            };
            const made = yield* createLinkCode(db, KEY.keyId, code, NOW);
            const phone = {
              id: "keyPHONEE",
              secretHash: yield* hashSecret("phone-secret"),
            };
            const redeemed = yield* redeemLinkCode(
              db,
              code.id,
              code.secretHash,
              phone,
              NOW + 60_000
            );
            const again = yield* redeemLinkCode(
              db,
              code.id,
              code.secretHash,
              {
                id: "keyOTHERR",
                secretHash: "y",
              },
              NOW + 61_000
            ).pipe(Effect.flip);
            const late = {
              id: "codeLATEE",
              secretHash: yield* hashSecret("late"),
            };
            yield* createLinkCode(db, KEY.keyId, late, NOW);
            const expired = yield* redeemLinkCode(
              db,
              late.id,
              late.secretHash,
              {
                id: "keyLATEEE",
                secretHash: "z",
              },
              NOW + 15 * 60_000 + 1
            ).pipe(Effect.flip);
            const phoneActive = yield* isActiveKey(
              db,
              {
                patronId: KEY.patronId,
                keyId: "keyPHONEE",
                secret: "phone-secret",
              },
              NOW + 60_000
            );
            const status = yield* statusOf(db, NOW + 60_000);
            return {
              expiresAt: made.expiresAt,
              redeemed,
              again: again.message,
              expired: expired.message,
              phoneActive,
              keys: status.keys,
            };
          })
        );
        expect(result).toStrictEqual({
          expiresAt: Date.UTC(2026, 9, 21, 0, 15),
          redeemed: { patronId: "patronAAAA" },
          again: "This code was already used",
          expired: "This code has expired",
          phoneActive: true,
          keys: 2,
        });
      } finally {
        patron.sqlite.close();
      }
    }));

  it("refuses a link code for an eleventh device", () =>
    withFile(async (path) => {
      const patron = await patronDb(path);
      try {
        for (let i = 2; i <= 10; i += 1) {
          patron.sqlite
            .prepare(
              `INSERT INTO patron_keys (id, secret_hash, created_at) VALUES ('key${i}', 'h', 0)`
            )
            .run();
        }
        const refused = await run(
          patron.db.pipe(
            Effect.flatMap((db) =>
              createLinkCode(
                db,
                KEY.keyId,
                { id: "codeFULLL", secretHash: "h" },
                NOW
              )
            ),
            Effect.flip
          )
        );
        expect(refused.message).toBe(
          "This membership is already on 10 devices. Forget one before adding another."
        );
      } finally {
        patron.sqlite.close();
      }
    }));

  it("rejects a pairing credential or invite code as a key, and a key as a pairing", () => {
    // formatToken shapes (three segments) never parse as patron keys.
    expect(
      Effect.runSync(
        themeForSend("note", "inboxAAAA.credAAAAA.secret-AAAAAAAA", () =>
          Effect.succeed(true)
        )
      )
    ).toBe("default");
  });
});

describe("sender themes on taps", () => {
  it("one membership styles taps to two different recipients; the recipients pay nothing", () =>
    withFile(async (path) => {
      const patron = await patronDb(path, [paid]);
      const jake = inboxDb(path, "jake", ["sam"]);
      const mia = inboxDb(path, "mia", ["samAtMia"]);
      try {
        const themes = await run(
          Effect.gen(function* twoInboxes() {
            const toJake = yield* send(jake.db, patron.db, {
              senderId: "sam",
              requestId: "req-jake-1",
              body: "Dinner's ready",
              theme: "broadsheet",
              patronKey: KEY_STRING,
              at: NOW,
            });
            const toMia = yield* send(mia.db, patron.db, {
              senderId: "samAtMia",
              requestId: "req-mia-1",
              body: "Call me",
              theme: "note",
              patronKey: KEY_STRING,
              at: NOW,
            });
            return [toJake, toMia];
          })
        );
        expect(themes).toStrictEqual(["broadsheet", "note"]);
        // Neither inbox holds any billing fact.
        expect(
          jake.sqlite.prepare("SELECT count(*) AS n FROM patron_events").get()
        ).toMatchObject({ n: 0 });
      } finally {
        patron.sqlite.close();
        jake.sqlite.close();
        mia.sqlite.close();
      }
    }));

  it("stores a nonpatron's or forged request in Default and still delivers it", () =>
    withFile(async (path) => {
      const unpaid = await patronDb(path);
      const inbox = inboxDb(path, "jake", ["sam"]);
      try {
        const result = await run(
          Effect.gen(function* refused() {
            const noKey = yield* send(inbox.db, null, {
              senderId: "sam",
              requestId: "req-nokey",
              body: "One",
              theme: "terminal",
              at: NOW,
            });
            const notPaid = yield* send(inbox.db, unpaid.db, {
              senderId: "sam",
              requestId: "req-unpaid",
              body: "Two",
              theme: "terminal",
              patronKey: KEY_STRING,
              at: NOW,
            });
            const forged = yield* send(inbox.db, unpaid.db, {
              senderId: "sam",
              requestId: "req-forged",
              body: "Three",
              theme: "terminal",
              patronKey: formatPatronKey({ ...KEY, secret: "forged-secret" }),
              at: NOW,
            });
            return { noKey, notPaid, forged };
          })
        );
        expect(result).toStrictEqual({
          noKey: "default",
          notPaid: "default",
          forged: "default",
        });
        expect(
          inbox.sqlite
            .prepare("SELECT body, state FROM taps ORDER BY body")
            .all()
            .map((row) => ({ ...row }))
        ).toStrictEqual([
          { body: "One", state: "pending" },
          { body: "Three", state: "pending" },
          { body: "Two", state: "pending" },
        ]);
      } finally {
        unpaid.sqlite.close();
        inbox.sqlite.close();
      }
    }));

  it("a recipient's own historical receiver subscription grants their senders nothing", () =>
    withFile(async (path) => {
      const inbox = inboxDb(path, "jake", ["sam"]);
      try {
        const theme = await run(
          Effect.gen(function* legacy() {
            yield* storePatronEvent(yield* inbox.db, paid);
            return yield* send(inbox.db, null, {
              senderId: "sam",
              requestId: "req-legacy",
              body: "Hi",
              theme: "billboard",
              at: NOW,
            });
          })
        );
        expect(theme).toBe("default");
      } finally {
        inbox.sqlite.close();
      }
    }));

  it("two senders show their own styles to the same free recipient", () =>
    withFile(async (path) => {
      const samPatron = await patronDb(path, [paid]);
      const inbox = inboxDb(path, "jake", ["sam", "ana"]);
      try {
        const seen = await run(
          Effect.gen(function* twoSenders() {
            yield* send(inbox.db, samPatron.db, {
              senderId: "sam",
              requestId: "req-sam",
              body: "From Sam",
              theme: "billboard",
              patronKey: KEY_STRING,
              at: NOW,
            });
            yield* send(inbox.db, null, {
              senderId: "ana",
              requestId: "req-ana",
              body: "From Ana",
              at: NOW + 1,
            });
            const rows = yield* readTaps(yield* inbox.db, undefined, 10);
            return rows.map((t) => [t.senderName, t.theme]);
          })
        );
        expect(seen).toStrictEqual([
          ["ana", "default"],
          ["sam", "billboard"],
        ]);
      } finally {
        samPatron.sqlite.close();
        inbox.sqlite.close();
      }
    }));

  it("after a lapse or refund new taps fall back to Default; taps already sent keep their theme, retries included", () =>
    withFile(async (path) => {
      const patron = await patronDb(path, [paid]);
      const inbox = inboxDb(path, "jake", ["sam"]);
      try {
        const result = await run(
          Effect.gen(function* lifecycle() {
            const before = yield* send(inbox.db, patron.db, {
              senderId: "sam",
              requestId: "req-before",
              body: "Before",
              theme: "note",
              patronKey: KEY_STRING,
              at: NOW,
            });
            const afterLapse = yield* send(inbox.db, patron.db, {
              senderId: "sam",
              requestId: "req-after-lapse",
              body: "After lapse",
              theme: "note",
              patronKey: KEY_STRING,
              at: AFTER_LAPSE,
            });
            // A delayed retry of the first send, after the lapse.
            const retry = yield* send(inbox.db, patron.db, {
              senderId: "sam",
              requestId: "req-before",
              body: "Before",
              theme: "note",
              patronKey: KEY_STRING,
              at: AFTER_LAPSE,
            });
            yield* storePatronEvent(yield* patron.db, refund);
            const afterRefund = yield* send(inbox.db, patron.db, {
              senderId: "sam",
              requestId: "req-after-refund",
              body: "After refund",
              theme: "note",
              patronKey: KEY_STRING,
              at: NOW + 120_000,
            });
            const history = (yield* readTaps(yield* inbox.db, undefined, 10))
              .map((t) => [t.body, t.theme])
              .toSorted();
            return { before, afterLapse, retry, afterRefund, history };
          })
        );
        expect(result).toStrictEqual({
          before: "note",
          afterLapse: "default",
          retry: "note",
          afterRefund: "default",
          history: [
            ["After lapse", "default"],
            ["After refund", "default"],
            ["Before", "note"],
          ],
        });
      } finally {
        patron.sqlite.close();
        inbox.sqlite.close();
      }
    }));

  it("reads taps stored by an older server as Default after migrating", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      migrate(sqlite, { through: "20261021162409_tap_appearance" });
      sqlite
        .prepare(
          "INSERT INTO credentials (id, kind, name, color, secret_hash, created_at) VALUES ('sam', 'sender', 'Sam', 'moss', 'x', 0)"
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO taps (id, request_id, sender_id, body, created_at, state, sequence) VALUES ('t1', 'r1', 'sam', 'Old tap', 1, 'pending', 1)"
        )
        .run();
      migrate(sqlite, { after: "20261021162409_tap_appearance" });
      try {
        const [tap] = await run(
          db.pipe(Effect.flatMap((d) => readTaps(d, undefined, 1)))
        );
        expect([tap?.body, tap?.theme]).toStrictEqual(["Old tap", "default"]);
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO taps (id, request_id, sender_id, body, created_at, state, sequence, theme) VALUES ('t2', 'r2', 'sam', 'x', 2, 'pending', 2, '<style>')"
            )
            .run()
        ).toThrow(/CHECK constraint failed: taps_theme/u);
      } finally {
        sqlite.close();
      }
    }));
});

describe("patron key authentication", () => {
  it("records when a key was last used, at most once a minute", () =>
    withFile(async (path) => {
      const patron = await patronDb(path);
      try {
        await run(
          Effect.gen(function* seen() {
            const db = yield* patron.db;
            const hash = yield* hashSecret(KEY.secret);
            yield* authenticateKey(db, KEY.keyId, hash, NOW);
            yield* authenticateKey(db, KEY.keyId, hash, NOW + 30_000);
          })
        );
        expect(
          patron.sqlite.prepare("SELECT last_seen_at FROM patron_keys").get()
        ).toMatchObject({ last_seen_at: NOW });
      } finally {
        patron.sqlite.close();
      }
    }));
});
