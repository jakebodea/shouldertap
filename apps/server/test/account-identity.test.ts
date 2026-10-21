import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  accountAction,
  accountData,
  claimAccountResource,
  reserveAccountBillingTarget,
  withAccountOperation,
} from "../src/account-identity";

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice'),('bob'); PRAGMA foreign_keys=ON;"
  );
  sqlite.exec(
    readFileSync(
      new URL("../account-migrations/0002_identity.sql", import.meta.url),
      "utf-8"
    )
  );
  sqlite.exec(
    readFileSync(
      new URL("../account-migrations/0003_billing_target.sql", import.meta.url),
      "utf-8"
    )
  );
  sqlite.exec(
    readFileSync(
      new URL(
        "../account-migrations/0004_account_operation.sql",
        import.meta.url
      ),
      "utf-8"
    )
  );
  sqlite.exec(
    readFileSync(
      new URL(
        "../account-migrations/0005_adoption_operation.sql",
        import.meta.url
      ),
      "utf-8"
    )
  );
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: never[]) {
          return {
            all() {
              return Promise.resolve({
                results: sqlite.prepare(sql).all(...args),
              });
            },
            run() {
              return Promise.resolve(sqlite.prepare(sql).run(...args));
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sqlite, db };
};
const inbox = {
  kind: "inbox" as const,
  id: "first",
  inbox_id: "first",
  credential_id: null,
  name: "My inbox",
};
describe("verified account ownership", () => {
  it("keeps both inboxes and selects one without merging or erasing either", async () => {
    const { sqlite, db } = database();
    try {
      await Effect.runPromise(claimAccountResource(db, "alice", inbox));
      await Effect.runPromise(
        claimAccountResource(db, "alice", {
          ...inbox,
          id: "second",
          inbox_id: "second",
          name: "Other inbox",
        })
      );
      const result = await Effect.runPromise(
        accountAction(
          {
            db,
            inboxes: {
              getByName() {
                throw new Error("not used");
              },
            },
            patrons: {
              getByName() {
                throw new Error("not used");
              },
            },
          },
          "alice",
          "default",
          { inboxId: "second" }
        ) as Effect.Effect<unknown, unknown>
      );
      expect(result).toStrictEqual({
        inboxes: [
          { id: "first", inboxId: "first", name: "My inbox" },
          { id: "second", inboxId: "second", name: "Other inbox" },
        ],
        senders: [],
        patrons: [],
        defaultInboxId: "second",
      });
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent for the owner and refuses a second account", async () => {
    const { sqlite, db } = database();
    try {
      await Effect.runPromise(claimAccountResource(db, "alice", inbox));
      await Effect.runPromise(claimAccountResource(db, "alice", inbox));
      const denied = await Effect.runPromise(
        claimAccountResource(db, "bob", inbox).pipe(Effect.flip)
      );
      expect(denied._tag).toBe("Conflict");
      await expect(
        Effect.runPromise(accountData(db, "alice"))
      ).resolves.toStrictEqual({
        inboxes: [{ id: "first", inboxId: "first", name: "My inbox" }],
        senders: [],
        patrons: [],
        defaultInboxId: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("concurrent requests for different memberships select one billing subject", async () => {
    const { sqlite, db } = database();
    try {
      await Effect.runPromise(
        claimAccountResource(db, "alice", {
          kind: "patron",
          id: "membership-one",
          inbox_id: null,
          credential_id: null,
          name: "One",
        })
      );
      await Effect.runPromise(
        claimAccountResource(db, "alice", {
          kind: "patron",
          id: "membership-two",
          inbox_id: null,
          credential_id: null,
          name: "Two",
        })
      );
      const results = await Promise.all([
        Effect.runPromise(
          reserveAccountBillingTarget(db, "alice", "membership-one").pipe(
            Effect.result
          )
        ),
        Effect.runPromise(
          reserveAccountBillingTarget(db, "alice", "membership-two").pipe(
            Effect.result
          )
        ),
      ]);
      expect(results.map((result) => result._tag).toSorted()).toStrictEqual([
        "Failure",
        "Success",
      ]);
      const chosen = await Effect.runPromise(
        reserveAccountBillingTarget(db, "alice", "membership-one")
      );
      expect(chosen).toBe("membership-one");
      const wrongAccount = await Effect.runPromise(
        reserveAccountBillingTarget(db, "bob", "membership-one").pipe(
          Effect.flip
        )
      );
      expect(wrongAccount._tag).toBe("Unauthorized");
    } finally {
      sqlite.close();
    }
  });

  it("serializes checkout and deletion and releases after a failed operation", async () => {
    const { sqlite, db } = database();
    try {
      const blocked = await Effect.runPromise(
        withAccountOperation(
          db,
          "alice",
          "checkout",
          withAccountOperation(
            db,
            "alice",
            "delete",
            Effect.succeed("deleted")
          ).pipe(Effect.flip)
        )
      );
      expect(blocked._tag).toBe("Conflict");
      const failed = await Effect.runPromise(
        withAccountOperation(
          db,
          "alice",
          "checkout",
          Effect.fail("provider unavailable")
        ).pipe(Effect.flip)
      );
      expect(failed).toBe("provider unavailable");
      const deleted = await Effect.runPromise(
        withAccountOperation(
          db,
          "alice",
          "delete",
          Effect.sync(() => {
            sqlite.prepare("DELETE FROM user WHERE id=?").run("alice");
            return "account deleted";
          })
        )
      );
      expect(deleted).toBe("account deleted");
      const staleRequest = await Effect.runPromise(
        withAccountOperation(
          db,
          "alice",
          "checkout",
          Effect.succeed("must not start")
        ).pipe(Effect.flip)
      );
      expect(staleRequest._tag).toBe("Unauthorized");
    } finally {
      sqlite.close();
    }
  });

  it("retains an interrupted-operation lock without a time-based escape", async () => {
    const { sqlite, db } = database();
    try {
      sqlite.exec(
        "INSERT INTO account_operation VALUES('alice','lost-worker-request','checkout')"
      );
      const result = await Effect.runPromise(
        withAccountOperation(
          db,
          "alice",
          "delete",
          Effect.succeed("must not delete")
        ).pipe(Effect.flip)
      );
      expect(result._tag).toBe("Conflict");
      const retained = sqlite
        .prepare(
          "SELECT request_id FROM account_operation WHERE user_id='alice'"
        )
        .get();
      expect(retained?.request_id).toBe("lost-worker-request");
    } finally {
      sqlite.close();
    }
  });

  it("adoption cannot attach a paid identity while deletion is checking the account", async () => {
    const { sqlite, db } = database();
    try {
      const deps = {
        db,
        inboxes: {
          getByName() {
            throw new Error("Unexpected inbox access");
          },
        },
        patrons: {
          getByName() {
            throw new Error("Unexpected patron access");
          },
        },
      };
      const result = await Effect.runPromise(
        withAccountOperation(
          db,
          "alice",
          "delete",
          accountAction(deps, "alice", "adopt", { tokens: [] }).pipe(
            Effect.flip
          )
          // The held deletion lock rejects adoption before its Durable Object
          // boundary can run; throwing namespace stubs above enforce that fact.
        ) as unknown as Effect.Effect<{ _tag: string }, unknown>
      );
      expect(result._tag).toBe("Conflict");
    } finally {
      sqlite.close();
    }
  });

  it("forward migration preserves an interrupted checkout lock and permits adoption locks", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(
        "CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice'),('bob');"
      );
      sqlite.exec(
        readFileSync(
          new URL(
            "../account-migrations/0004_account_operation.sql",
            import.meta.url
          ),
          "utf-8"
        )
      );
      sqlite.exec(
        "INSERT INTO account_operation VALUES('alice','original-checkout','checkout')"
      );
      sqlite.exec(
        readFileSync(
          new URL(
            "../account-migrations/0005_adoption_operation.sql",
            import.meta.url
          ),
          "utf-8"
        )
      );
      sqlite.exec(
        "INSERT INTO account_operation VALUES('bob','adoption-request','adopt')"
      );
      expect(
        sqlite
          .prepare(
            "SELECT request_id FROM account_operation WHERE user_id='alice'"
          )
          .get()?.request_id
      ).toBe("original-checkout");
      expect(
        sqlite
          .prepare("SELECT kind FROM account_operation WHERE user_id='bob'")
          .get()?.kind
      ).toBe("adopt");
    } finally {
      sqlite.close();
    }
  });
});
