import { Conflict } from "@shouldertap/domain";
import { and, count, eq, lt, sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import type { PatronEvent } from "./patron";
import { patronOf, promptEligible, nextSupportAsk } from "./patron";
import {
  inbox,
  taps,
  patronEvents,
  patronCheckout,
  refundedOrders,
} from "./schema";

/** Storage operations shared by the DO and real SQLite boundary tests. */
export const reserveCheckout = Effect.fn(function* reserveCheckout(
  db: EffectSQLiteDoDatabase,
  requestId: string,
  at: number
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* reserve() {
      const events = (yield* tx.select().from(patronEvents)).map(
        (r) => r.event
      );
      if (!patronOf(events, at).canSubscribe) {
        return yield* new Conflict({
          message:
            "Manage your existing support membership before starting another.",
        });
      }
      const [existing] = yield* tx.select().from(patronCheckout);
      if (existing) {
        if (!existing.url) {
          return yield* new Conflict({
            message:
              "A checkout is being prepared or needs reconciliation. Please wait, or contact support if this persists.",
          });
        }
        return {
          requestId: existing.requestId,
          url: existing.url,
          providerId: existing.providerId,
        };
      }
      yield* tx
        .insert(patronCheckout)
        .values({ id: 1, requestId, createdAt: at, url: null });
      return { requestId, url: null, providerId: null };
    })
  );
});

export const claimPrompt = Effect.fn(function* claimPrompt(
  db: EffectSQLiteDoDatabase,
  at: number
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* claim() {
      const [row] = yield* tx.select().from(inbox).where(eq(inbox.id, 1));
      const events = (yield* tx.select().from(patronEvents)).map(
        (r) => r.event
      );
      const [pending] = yield* tx
        .select({ n: count() })
        .from(taps)
        .where(eq(taps.state, "pending"));
      const show =
        !!row &&
        promptEligible(
          row,
          patronOf(events, at, row.paidAt !== null),
          (pending?.n ?? 0) > 0,
          at
        );
      if (show) {
        yield* tx
          .update(inbox)
          .set({ supportAskAfter: nextSupportAsk(at) })
          .where(eq(inbox.id, 1));
      }
      return { show };
    })
  );
});

export const storePatronEvent = (
  db: EffectSQLiteDoDatabase,
  event: PatronEvent
): Effect.Effect<boolean, EffectDrizzleQueryError | SqlError> =>
  db.transaction((tx) =>
    Effect.gen(function* storeFact() {
      const inserted = yield* tx
        .insert(patronEvents)
        .values({ id: event.id, event })
        .onConflictDoNothing()
        .returning({ id: patronEvents.id });
      if (inserted.length > 0 && event.type.startsWith("subscription.")) {
        yield* tx
          .delete(patronCheckout)
          .where(lt(patronCheckout.createdAt, event.at));
      }
      return inserted.length > 0;
    })
  );

export const storeLegacyPurchase = (
  db: EffectSQLiteDoDatabase,
  purchase: { at: number; orderId: string; email: string | null }
): Effect.Effect<boolean, EffectDrizzleQueryError | SqlError> =>
  db.transaction((tx) =>
    Effect.gen(function* storeLegacy() {
      const [refunded] = yield* tx
        .select()
        .from(refundedOrders)
        .where(eq(refundedOrders.id, purchase.orderId));
      if (refunded) {
        return false;
      }
      const updated = yield* tx
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
      return updated.length > 0;
    })
  );

export const storeLegacyRefund = (
  db: EffectSQLiteDoDatabase,
  orderId: string
): Effect.Effect<boolean, EffectDrizzleQueryError | SqlError> =>
  db.transaction((tx) =>
    Effect.gen(function* refundLegacy() {
      yield* tx
        .insert(refundedOrders)
        .values({ id: orderId })
        .onConflictDoNothing();
      const updated = yield* tx
        .update(inbox)
        .set({ paidAt: null })
        .where(and(eq(inbox.id, 1), eq(inbox.orderId, orderId)))
        .returning({ id: inbox.id });
      return updated.length > 0;
    })
  );
