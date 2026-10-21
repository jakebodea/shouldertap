import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { deleteAccount } from "../src/account-delete";
import {
  claimAccountResource,
  withAccountOperation,
} from "../src/account-identity";
import { accountDeletionState } from "../src/patron-identity";
import type { PatronRpc } from "../src/SenderPatron";
import { migrate, open, withFile } from "./do-sqlite";

const NOW = Date.UTC(2026, 9, 21);
const fixture = async (path: string) => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('owner');"
  );
  for (const name of [
    "0002_identity",
    "0003_billing_target",
    "0004_account_operation",
    "0005_adoption_operation",
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../account-migrations/${name}.sql`, import.meta.url),
        "utf-8"
      )
    );
  }
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
  const patron = open(path);
  migrate(patron.sqlite, { folder: "drizzle-patron" });
  patron.sqlite.exec(
    "INSERT INTO patron(id,patron_id,created_at) VALUES(1,'membership',1)"
  );
  await Effect.runPromise(
    claimAccountResource(db, "owner", {
      kind: "patron",
      id: "membership",
      inbox_id: null,
      credential_id: null,
      name: "Membership",
    })
  );
  // Replace only the DO RPC transport; queries and lifecycle policy run against
  // real SQLite through the same production helper used by SenderPatron.
  const patrons = {
    getByName: () =>
      ({
        accountDeletionStatus: () =>
          Effect.gen(function* readPatronDeletionState() {
            return yield* accountDeletionState(yield* patron.db, NOW);
          }).pipe(Effect.orDie),
      }) as unknown as PatronRpc,
  };
  const remove = () => {
    sqlite.exec("DELETE FROM user WHERE id='owner'");
    return Promise.resolve(Response.json({ deleted: true }));
  };
  // The RPC transport stub resolves its real SQL dependencies itself; its
  // structural PatronRpc type is the only source of the RuntimeContext type.
  const deletion = () =>
    deleteAccount(db, patrons, "owner", remove) as unknown as Effect.Effect<
      Response,
      unknown
    >;
  return {
    sqlite,
    db,
    patron,
    deletion,
    close() {
      sqlite.close();
      patron.sqlite.close();
    },
  };
};

const paidEvent = {
  id: "paid",
  at: NOW - 1000,
  type: "subscription.paid",
  subscriptionId: "subscription",
  customerId: "customer",
  periodEnd: NOW + 86_400_000,
  transactionId: "payment",
  refundTransactionId: null,
};

describe("account deletion preserves billing access", () => {
  it.each(["active", "pending"] as const)(
    "blocks deletion with %s billing and preserves ownership",
    (state) =>
      withFile(async (path) => {
        const f = await fixture(path);
        try {
          if (state === "active") {
            f.patron.sqlite
              .prepare("INSERT INTO patron_events(id,event) VALUES('paid',?)")
              .run(JSON.stringify(paidEvent));
          } else {
            f.patron.sqlite.exec(
              "INSERT INTO patron_checkout(id,request_id,created_at) VALUES(1,'uncertain-checkout',1)"
            );
          }
          const response = await Effect.runPromise(f.deletion());
          expect(response.status).toBe(409);
          expect(f.sqlite.prepare("SELECT id FROM user").get()?.id).toBe(
            "owner"
          );
          expect(
            f.sqlite.prepare("SELECT id FROM account_resource").get()?.id
          ).toBe("membership");
        } finally {
          f.close();
        }
      })
  );

  it("deletes canceled historical membership account and cascades its ownership refs", () =>
    withFile(async (path) => {
      const f = await fixture(path);
      try {
        f.patron.sqlite
          .prepare("INSERT INTO patron_events(id,event) VALUES('canceled',?)")
          .run(
            JSON.stringify({
              ...paidEvent,
              id: "canceled",
              type: "subscription.canceled",
              periodEnd: NOW - 1000,
            })
          );
        const response = await Effect.runPromise(f.deletion());
        await expect(response.json()).resolves.toStrictEqual({ deleted: true });
        expect(
          f.sqlite.prepare("SELECT count(*) AS n FROM user").get()?.n
        ).toBe(0);
        expect(
          f.sqlite.prepare("SELECT count(*) AS n FROM account_resource").get()
            ?.n
        ).toBe(0);
        expect(
          f.patron.sqlite.prepare("SELECT patron_id FROM patron").get()
            ?.patron_id
        ).toBe("membership");
      } finally {
        f.close();
      }
    }));

  it.each(["checkout", "adopt"] as const)(
    "cannot delete while %s holds the account operation lock",
    (kind) =>
      withFile(async (path) => {
        const f = await fixture(path);
        try {
          const denied = await Effect.runPromise(
            withAccountOperation(
              f.db,
              "owner",
              kind,
              f.deletion().pipe(Effect.flip)
            )
          );
          expect(denied).toMatchObject({ _tag: "Conflict" });
          expect(f.sqlite.prepare("SELECT id FROM user").get()?.id).toBe(
            "owner"
          );
        } finally {
          f.close();
        }
      })
  );
});
