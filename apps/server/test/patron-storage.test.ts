import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { webhookAction } from "../src/Creem";
import { patronOf } from "../src/patron";
import {
  reserveCheckout,
  storePatronEvent,
  storeLegacyPurchase,
  storeLegacyRefund,
} from "../src/patron-storage";
import { planOf } from "../src/plan";
import { patronEvents, inbox } from "../src/schema";
import { migrate, open, withFile } from "./do-sqlite";

const NOW = Date.UTC(2026, 9, 21);

describe("durable support boundaries", () => {
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
