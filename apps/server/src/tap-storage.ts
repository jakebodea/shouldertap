import { Conflict, TooManyRequests } from "@shouldertap/domain";
import type { SendTapRequest } from "@shouldertap/domain";
import { and, count, eq, gt, sql } from "drizzle-orm";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

import { inbox, taps } from "./schema";

const TAPS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** Persist an authorized tap. Functional access deliberately has no billing
 * dependency: only idempotency and the shared safety limit can refuse it. */
export const recordTap = (
  db: EffectSQLiteDoDatabase,
  senderId: string,
  request: SendTapRequest,
  id: string,
  createdAt: number
) =>
  db.transaction((tx) =>
    Effect.gen(function* insertTap() {
      const [existing] = yield* tx
        .select()
        .from(taps)
        .where(
          and(
            eq(taps.senderId, senderId),
            eq(taps.requestId, request.requestId)
          )
        );
      if (existing) {
        // Idempotent retry: same request id, same message → same tap.
        if (existing.body !== request.body) {
          return yield* new Conflict({
            message: "Request id was reused with a different message",
          });
        }
        return { id: existing.id, isNew: false };
      }
      const [recent] = yield* tx
        .select({ n: count() })
        .from(taps)
        .where(
          and(
            eq(taps.senderId, senderId),
            gt(taps.createdAt, createdAt - HOUR_MS)
          )
        );
      if ((recent?.n ?? 0) >= TAPS_PER_HOUR) {
        return yield* new TooManyRequests({
          message: "You've sent a lot of taps this hour. Try again later.",
        });
      }
      const [row] = yield* tx
        .update(inbox)
        .set({ sequence: sql`${inbox.sequence} + 1` })
        .where(eq(inbox.id, 1))
        .returning({ sequence: inbox.sequence });
      yield* tx.insert(taps).values({
        id,
        requestId: request.requestId,
        senderId,
        body: request.body,
        createdAt,
        state: "pending",
        sequence: row?.sequence ?? 0,
      });
      return { id, isNew: true };
    })
  );
