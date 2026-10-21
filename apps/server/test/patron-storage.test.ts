import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

import * as SqliteDo from "@effect/sql-sqlite-do/SqliteClient";
import * as Drizzle from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { webhookAction } from "../src/Creem";
import type { PatronEvent } from "../src/patron";
import { patronOf } from "../src/patron";
import {
  claimPrompt,
  reserveCheckout,
  storePatronEvent,
  storeLegacyPurchase,
  storeLegacyRefund,
} from "../src/patron-storage";
import { planOf } from "../src/plan";
import { patronEvents, inbox } from "../src/schema";
import { recordTap } from "../src/tap-storage";

const NOW = Date.UTC(2026, 9, 21);

/** Fake only Cloudflare's storage boundary; run the production Effect/Drizzle
 * queries and transactions against a real file-backed SQLite database. */
const open = (path: string) => {
  const sqlite = new DatabaseSync(path);
  const storage = {
    sql: {
      exec(query: string, ...params: SQLInputValue[]) {
        const statement = sqlite.prepare(query);
        const columns = statement.columns().map((c) => c.name);
        const rows = statement.all(...params);
        return {
          columnNames: columns,
          raw: () => rows.map((row) => columns.map((c) => row[c])),
        };
      },
    },
    transactionSync<A>(f: () => A): A {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const value = f();
        sqlite.exec("COMMIT");
        return value;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const db = Drizzle.makeWithDefaults({ storage }).pipe(
    Effect.provide(SqliteDo.layer({ db: storage.sql }))
  );
  return { sqlite, db };
};

const migrate = (sqlite: DatabaseSync) => {
  for (const name of [
    "20260930165314_init",
    "20260930180548_sender_color",
    "20261001163359_payments",
    "20261002221852_device_platform",
    "20261002230031_push",
    "20261021152554_free_core_patrons",
  ]) {
    sqlite.exec(
      readFileSync(
        new URL(`../drizzle/${name}/migration.sql`, import.meta.url),
        "utf-8"
      ).replaceAll("--> statement-breakpoint", "")
    );
  }
};

const withFile = async (f: (path: string) => Promise<void>) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "shouldertap-patron-"));
  try {
    await f(nodePath.join(dir, "inbox.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("durable support boundaries", () => {
  it("a phone-only inbox accepts taps after its old deadline, cancellation and refund", () =>
    withFile(async (path) => {
      const connection = open(path);
      migrate(connection.sqlite);
      connection.sqlite.exec(
        "INSERT INTO inbox (id,inbox_id,recipient_name,trial_ends_at) VALUES (1,'phone-only','Ari',1)"
      );
      connection.sqlite.exec(
        "INSERT INTO credentials (id,kind,name,platform,secret_hash,created_at) VALUES ('phone','device','Ari','iphone','unused',1),('sender','sender','Sam',NULL,'unused',1)"
      );
      const paid: PatronEvent = {
        id: "paid",
        at: NOW,
        type: "subscription.paid",
        subscriptionId: "sub_phone",
        customerId: "customer",
        periodEnd: NOW + 86_400_000,
        transactionId: "transaction",
        refundTransactionId: null,
      };
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* sendWithoutBillingGate() {
              const db = yield* connection.db;
              yield* recordTap(
                db,
                "sender",
                { requestId: "before", body: "After the old deadline" },
                "tap-before",
                NOW
              );
              yield* storePatronEvent(db, paid);
              yield* storePatronEvent(db, {
                ...paid,
                id: "canceled",
                at: NOW + 1,
                type: "subscription.canceled",
              });
              yield* recordTap(
                db,
                "sender",
                { requestId: "cancel", body: "After cancellation" },
                "tap-cancel",
                NOW + 2
              );
              yield* storePatronEvent(db, {
                ...paid,
                id: "refund",
                at: NOW + 3,
                type: "refund.created",
                refundTransactionId: "transaction",
              });
              yield* recordTap(
                db,
                "sender",
                { requestId: "refund", body: "After refund" },
                "tap-refund",
                NOW + 4
              );
              const events = (yield* db.select().from(patronEvents)).map(
                (row) => row.event
              );
              return patronOf(events, NOW + 5);
            })
          )
        );
        expect(result.active).toBeFalsy();
        expect(
          connection.sqlite
            .prepare("SELECT body,state FROM taps ORDER BY created_at")
            .all()
            .map((row) => ({ ...row }))
        ).toStrictEqual([
          { body: "After the old deadline", state: "pending" },
          { body: "After cancellation", state: "pending" },
          { body: "After refund", state: "pending" },
        ]);
        expect(
          connection.sqlite
            .prepare("SELECT platform FROM credentials WHERE kind='device'")
            .all()
            .map((row) => ({ ...row }))
        ).toStrictEqual([{ platform: "iphone" }]);
      } finally {
        connection.sqlite.close();
      }
    }));

  it("migrates an expired inbox, claims once across devices and persists the cooldown across restart", () =>
    withFile(async (path) => {
      const first = open(path);
      migrate(first.sqlite);
      first.sqlite
        .prepare(
          "INSERT INTO inbox (id,inbox_id,recipient_name,trial_ends_at,first_answered_at,answered_count) VALUES (1,'inbox123','Jake',1,1791331200000,10)"
        )
        .run();
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* claims() {
            const db = yield* first.db;
            const one = yield* claimPrompt(db, NOW);
            const two = yield* claimPrompt(db, NOW);
            return [one, two];
          })
        )
      );
      expect(result).toStrictEqual([{ show: true }, { show: false }]);
      first.sqlite.close();
      const reopened = open(path);
      try {
        const resultAfterRestart = await Effect.runPromise(
          Effect.scoped(
            reopened.db.pipe(
              Effect.flatMap((db) => claimPrompt(db, Date.UTC(2027, 0, 18)))
            )
          )
        );
        expect(resultAfterRestart).toStrictEqual({ show: false });
        expect(
          reopened.sqlite.prepare("SELECT support_ask_after FROM inbox").get()
        ).toMatchObject({ support_ask_after: 1_800_316_800_000 });
      } finally {
        reopened.sqlite.close();
      }
    }));

  it("reserves one checkout and reuses its URL after restart instead of creating another", () =>
    withFile(async (path) => {
      const first = open(path);
      migrate(first.sqlite);
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* reserve() {
            const db = yield* first.db;
            const reserved = yield* reserveCheckout(db, "attempt-one", NOW);
            const second = yield* reserveCheckout(db, "attempt-two", NOW).pipe(
              Effect.flip
            );
            return { reserved, conflict: second._tag };
          })
        )
      );
      expect(result).toStrictEqual({
        reserved: { requestId: "attempt-one", url: null, providerId: null },
        conflict: "Conflict",
      });
      first.sqlite
        .prepare(
          "UPDATE patron_checkout SET url='https://creem.io/test-checkout'"
        )
        .run();
      first.sqlite.close();
      const reopened = open(path);
      try {
        const resumed = await Effect.runPromise(
          Effect.scoped(
            reopened.db.pipe(
              Effect.flatMap((db) =>
                reserveCheckout(db, "attempt-three", NOW + 1000)
              )
            )
          )
        );
        expect(resumed).toStrictEqual({
          requestId: "attempt-one",
          url: "https://creem.io/test-checkout",
          providerId: null,
        });
      } finally {
        reopened.sqlite.close();
      }
    }));

  it("stores real webhook shapes idempotently, so a refund before paid never resurrects patron status", () =>
    withFile(async (path) => {
      const first = open(path);
      migrate(first.sqlite);
      const subscription = {
        id: "sub_1",
        product: "prod_patron",
        customer: "cust_1",
        last_transaction_id: "tran_1",
        current_period_end_date: "2027-10-21T00:00:00Z",
        metadata: { inbox_id: "inbox123" },
      };
      const paid = webhookAction(
        JSON.stringify({
          id: "evt_paid",
          eventType: "subscription.paid",
          created_at: NOW,
          object: subscription,
        }),
        "prod_legacy",
        "prod_patron"
      );
      const refund = webhookAction(
        JSON.stringify({
          id: "evt_refund",
          eventType: "refund.created",
          created_at: NOW + 1000,
          object: {
            status: "succeeded",
            transaction: { id: "tran_1", subscription: "sub_1" },
            subscription,
          },
        }),
        "prod_legacy",
        "prod_patron"
      );
      if (paid.kind !== "patron" || refund.kind !== "patron") {
        throw new Error("Wrong routing");
      }
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* deliver() {
              const db = yield* first.db;
              const inserted = [
                yield* storePatronEvent(db, refund.event),
                yield* storePatronEvent(db, paid.event),
                yield* storePatronEvent(db, paid.event),
              ];
              const events = (yield* db.select().from(patronEvents)).map(
                (row) => row.event
              );
              return { inserted, status: patronOf(events, NOW + 2000) };
            })
          )
        );
        expect(result.inserted).toStrictEqual([true, true, false]);
        expect(result.status).toMatchObject({
          active: false,
          status: "inactive",
          paidUntil: 0,
          canManage: true,
        });
      } finally {
        first.sqlite.close();
      }
    }));
});

describe("historical purchases remain separate from annual support", () => {
  it("keeps purchase evidence and a refund tombstone prevents late purchase retries from restoring it", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      migrate(sqlite);
      sqlite
        .prepare(
          "INSERT INTO inbox (id,inbox_id,recipient_name,trial_ends_at,paid_at,order_id,purchase_email) VALUES (1,'inbox123','Jake',1,1791331200000,'ord_old','buyer@example.com')"
        )
        .run();
      try {
        const before = sqlite
          .prepare("SELECT paid_at,order_id,purchase_email FROM inbox")
          .get();
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* legacy() {
              const database = yield* db;
              yield* storeLegacyRefund(database, "ord_old");
              const late = yield* storeLegacyPurchase(database, {
                at: NOW,
                orderId: "ord_old",
                email: "buyer@example.com",
              });
              const [row] = yield* database.select().from(inbox);
              return { late, row, plan: planOf(row, NOW) };
            })
          )
        );
        expect(before).toMatchObject({
          paid_at: 1_791_331_200_000,
          order_id: "ord_old",
          purchase_email: "buyer@example.com",
        });
        expect(result.row).toMatchObject({
          paidAt: null,
          orderId: "ord_old",
          purchaseEmail: "buyer@example.com",
        });
        expect(result.plan).toStrictEqual({ status: "paid", trialEndsAt: 1 });
        expect(result.late).toBeFalsy();
      } finally {
        sqlite.close();
      }
    }));
});
