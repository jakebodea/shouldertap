import {
  parsePatronKey,
  parseToken,
  InvalidRequest,
  Conflict,
  Unauthorized,
} from "@shouldertap/domain";
import type { DevicePlatform } from "@shouldertap/domain";
import * as Effect from "effect/Effect";

import type { InboxRpc } from "./Inbox";
import type { PatronRpc } from "./SenderPatron";

interface Resource {
  kind: "inbox" | "sender" | "patron";
  id: string;
  inbox_id: string | null;
  credential_id: string | null;
  name: string;
}
interface Dependencies {
  db: D1Database;
  inboxes: { getByName: (id: string) => InboxRpc };
  patrons: { getByName: (id: string) => PatronRpc };
}
const query = <A>(db: D1Database, sql: string, ...values: unknown[]) =>
  Effect.promise(async () => {
    const result = await db
      .prepare(sql)
      .bind(...values)
      .all<A>();
    return result.results;
  });

/** Only call with a verified account session. Never derives ownership from email or billing facts. */
export const accountResources = (db: D1Database, userId: string) =>
  query<Resource>(
    db,
    "SELECT kind,id,inbox_id,credential_id,name FROM account_resource WHERE user_id=? ORDER BY created_at,id",
    userId
  );
export const accountData = Effect.fn(function* accountData(
  db: D1Database,
  userId: string
) {
  const rows = yield* accountResources(db, userId);
  const [preference] = yield* query<{ default_inbox_id: string | null }>(
    db,
    "SELECT default_inbox_id FROM account_preference WHERE user_id=?",
    userId
  );
  return {
    inboxes: rows
      .filter((r) => r.kind === "inbox")
      .map((r) => ({ id: r.id, inboxId: r.inbox_id ?? "", name: r.name })),
    senders: rows
      .filter((r) => r.kind === "sender")
      .map((r) => ({
        id: r.id,
        inboxId: r.inbox_id ?? "",
        credentialId: r.credential_id ?? "",
        name: r.name,
      })),
    patrons: rows
      .filter((r) => r.kind === "patron")
      .map((r) => ({ id: r.id, name: r.name })),
    defaultInboxId: preference?.default_inbox_id ?? null,
  };
});

/** Unique ownership is immutable. A conflicting account never steals a credential. */
export const claimAccountResource = Effect.fn(function* claimAccountResource(
  db: D1Database,
  userId: string,
  resource: Resource
) {
  yield* Effect.promise(() =>
    db
      .prepare(
        "INSERT INTO account_resource(kind,id,user_id,inbox_id,credential_id,name,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO NOTHING"
      )
      .bind(
        resource.kind,
        resource.id,
        userId,
        resource.inbox_id,
        resource.credential_id,
        resource.name,
        Date.now()
      )
      .run()
  );
  const [owner] = yield* query<{ user_id: string }>(
    db,
    "SELECT user_id FROM account_resource WHERE kind=? AND id=?",
    resource.kind,
    resource.id
  );
  if (owner?.user_id !== userId) {
    return yield* new Conflict({
      message: "This identity already belongs to another account",
    });
  }
});

export type AccountOperation = "checkout" | "delete" | "adopt";

/** Serialize account checkout and deletion, including their external effects.
 * A process lost before its finalizer leaves a fail-closed lock. Release only
 * this invocation's row; successful deletion removes it by FK cascade. The
 * checkout callback must persist its Patron DO reservation before contacting
 * the provider, retaining that reservation on uncertain provider outcomes. */
export const withAccountOperation = <A, E, R>(
  db: D1Database,
  userId: string,
  kind: AccountOperation,
  operation: Effect.Effect<A, E, R>
): Effect.Effect<A, E | Conflict | Unauthorized, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* acquireAccountOperation() {
      const requestId = crypto.randomUUID();
      // SELECT avoids an FK violation when an authenticated request outlives
      // deletion; it cannot recreate an account or acquire a post-delete lock.
      yield* Effect.promise(() =>
        db
          .prepare(
            "INSERT INTO account_operation(user_id,request_id,kind) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM user WHERE id=?) ON CONFLICT(user_id) DO NOTHING"
          )
          .bind(userId, requestId, kind, userId)
          .run()
      );
      const [lock] = yield* query<{ request_id: string }>(
        db,
        "SELECT request_id FROM account_operation WHERE user_id=?",
        userId
      );
      if (!lock) {
        return yield* new Unauthorized({ message: "Account no longer exists" });
      }
      if (lock.request_id !== requestId) {
        return yield* new Conflict({
          message:
            "Another account operation is in progress. Please wait, or contact support if this persists.",
        });
      }
      return requestId;
    }),
    () => operation,
    (requestId) =>
      Effect.promise(() =>
        db
          .prepare(
            "DELETE FROM account_operation WHERE user_id=? AND request_id=?"
          )
          .bind(userId, requestId)
          .run()
      )
  );

/** Route body parsing and verified-session/origin checks belong to the HTTP boundary. */
// oxlint-disable-next-line complexity -- Four explicit authenticated route actions share ownership validation.
export const accountAction = Effect.fn(function* accountAction(
  { db, inboxes, patrons }: Dependencies,
  userId: string,
  action: string,
  body: unknown
) {
  if (action === "data") {
    return yield* accountData(db, userId);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return yield* new InvalidRequest({ message: "Expected an object" });
  }
  const input = body as Record<string, unknown>;
  if (action === "adopt") {
    return yield* withAccountOperation(
      db,
      userId,
      "adopt",
      Effect.gen(function* adoptWhileLocked() {
        if (
          input.tokens !== undefined &&
          (!Array.isArray(input.tokens) ||
            input.tokens.length > 50 ||
            input.tokens.some((t) => typeof t !== "string"))
        ) {
          return yield* new InvalidRequest({ message: "Invalid credentials" });
        }
        // Authenticate every proof before writing any ownership rows. A later conflict may
        // leave earlier identities adopted; retry is idempotent and never merges inboxes.
        const claims: Resource[] = [];
        for (const value of (input.tokens ?? []) as string[]) {
          const token = parseToken(value);
          if (!token) {
            return yield* new InvalidRequest({ message: "Invalid credential" });
          }
          const snapshot = yield* inboxes
            .getByName(token.inboxId)
            .snapshot(token);
          const owner = snapshot.kind === "device";
          claims.push({
            kind: owner ? "inbox" : "sender",
            id: owner
              ? token.inboxId
              : `${token.inboxId}:${snapshot.credentialId}`,
            inbox_id: token.inboxId,
            credential_id: owner ? null : snapshot.credentialId,
            name: snapshot.recipientName,
          });
        }
        if (input.patronKey !== undefined) {
          if (typeof input.patronKey !== "string") {
            return yield* new InvalidRequest({
              message: "Invalid membership key",
            });
          }
          const key = parsePatronKey(input.patronKey);
          if (!key) {
            return yield* new InvalidRequest({
              message: "Invalid membership key",
            });
          }
          yield* patrons.getByName(key.patronId).status(key);
          claims.push({
            kind: "patron",
            id: key.patronId,
            inbox_id: null,
            credential_id: null,
            name: "Patron membership",
          });
        }
        for (const claim of claims) {
          yield* claimAccountResource(db, userId, claim);
        }
        return yield* accountData(db, userId);
      })
    );
  }
  if (action === "default") {
    if (typeof input.inboxId !== "string") {
      return yield* new InvalidRequest({ message: "Choose an inbox" });
    }
    const rows = yield* accountResources(db, userId);
    if (!rows.some((r) => r.kind === "inbox" && r.id === input.inboxId)) {
      return yield* new Unauthorized({
        message: "Inbox does not belong to this account",
      });
    }
    yield* Effect.promise(() =>
      db
        .prepare(
          "INSERT INTO account_preference(user_id,default_inbox_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET default_inbox_id=excluded.default_inbox_id"
        )
        .bind(userId, input.inboxId)
        .run()
    );
    return yield* accountData(db, userId);
  }
  if (action === "restore") {
    const rows = yield* accountResources(db, userId);
    const resource = rows.find(
      (r) => r.kind === input.kind && r.id === input.id
    );
    if (!resource) {
      return yield* new Unauthorized({
        message: "Identity does not belong to this account",
      });
    }
    if (resource.kind === "patron") {
      return yield* patrons.getByName(resource.id).accountRestore(resource.id);
    }
    const platform = input.platform ?? "iphone";
    if (!["mac", "iphone", "windows"].includes(platform as string)) {
      return yield* new InvalidRequest({ message: "Invalid platform" });
    }
    const name = input.deviceName ?? "Account device";
    if (typeof name !== "string" || !name.trim() || name.length > 80) {
      return yield* new InvalidRequest({ message: "Invalid device name" });
    }
    return yield* inboxes
      .getByName(resource.inbox_id ?? "")
      .accountRestore(
        resource.inbox_id ?? "",
        resource.kind === "sender" ? resource.credential_id : null,
        name.trim(),
        platform as DevicePlatform
      );
  }
  return yield* new InvalidRequest({ message: "Unknown account action" });
});

/** Resolve the existing membership first; a deterministic id plus unique D1
 * ownership makes simultaneous first checkouts converge on the same subject. */
export const ensureAccountPatron = Effect.fn(function* ensureAccountPatron(
  { db, patrons }: Pick<Dependencies, "db" | "patrons">,
  userId: string
) {
  const existing = (yield* accountResources(db, userId)).filter(
    (r) => r.kind === "patron"
  );
  if (existing.length > 1) {
    return yield* new Conflict({
      message: "Choose an existing membership before starting checkout",
    });
  }
  if (existing[0]) {
    yield* patrons.getByName(existing[0].id).initializeAccount(existing[0].id);
    return existing[0].id;
  }
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`shouldertap-account-patron-v1:${userId}`)
    )
  );
  const id = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  yield* claimAccountResource(db, userId, {
    kind: "patron",
    id,
    inbox_id: null,
    credential_id: null,
    name: "Patron membership",
  });
  // An interrupted initialization is retried with exactly the same subject.
  yield* patrons.getByName(id).initializeAccount(id);
  return id;
});

/** Permanent while unresolved: provider uncertainty must never unlock a second
 * patron subject merely because another request or device chose it. */
export const reserveAccountBillingTarget = Effect.fn(
  function* reserveAccountBillingTarget(
    db: D1Database,
    userId: string,
    patronId: string
  ) {
    // Ownership is checked inside the INSERT as well as by the route so this
    // primitive cannot reserve a different account's membership.
    yield* Effect.promise(() =>
      db
        .prepare(
          "INSERT INTO account_billing_target(user_id,patron_id,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM account_resource WHERE user_id=? AND kind='patron' AND id=?) ON CONFLICT(user_id) DO NOTHING"
        )
        .bind(userId, patronId, Date.now(), userId, patronId)
        .run()
    );
    const [target] = yield* query<{ patron_id: string }>(
      db,
      "SELECT patron_id FROM account_billing_target WHERE user_id=?",
      userId
    );
    if (!target) {
      return yield* new Unauthorized({
        message: "Membership does not belong to this account",
      });
    }
    if (target.patron_id !== patronId) {
      return yield* new Conflict({
        message:
          "This account already has a membership checkout. Manage that membership before starting another.",
      });
    }
    return target.patron_id;
  }
);
export const accountBillingTarget = Effect.fn(function* accountBillingTarget(
  db: D1Database,
  userId: string
) {
  const [target] = yield* query<{ patron_id: string }>(
    db,
    "SELECT patron_id FROM account_billing_target WHERE user_id=?",
    userId
  );
  return target?.patron_id ?? null;
});
