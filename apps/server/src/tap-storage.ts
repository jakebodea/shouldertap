import { Conflict, fallbackColor, TooManyRequests } from "@shouldertap/domain";
import type { SendTapRequest, Tap } from "@shouldertap/domain";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

import type { VerifiedTheme } from "./presentation";
import { credentials, inbox, taps } from "./schema";

/** Taps one sender may send in any rolling hour. */
export const TAPS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** What the Inbox stores from a send: never the client's theme claim or key. */
export type TapMessage = Omit<SendTapRequest, "theme" | "patronKey">;

/**
 * Accepts one send in a transaction. The theme is captured on the row now and
 * never rewritten, so a sender changing style, or their membership lapsing or
 * being refunded later, doesn't restyle taps already sent. A retry with the
 * same request id returns the original tap, theme included.
 */
export const storeTap = (
  db: EffectSQLiteDoDatabase,
  {
    senderId,
    message,
    theme,
    id,
    at,
  }: {
    senderId: string;
    message: TapMessage;
    theme: VerifiedTheme;
    id: string;
    at: number;
  }
) =>
  db.transaction((tx) =>
    Effect.gen(function* insertTap() {
      const [existing] = yield* tx
        .select()
        .from(taps)
        .where(
          and(
            eq(taps.senderId, senderId),
            eq(taps.requestId, message.requestId)
          )
        );
      if (existing) {
        // Idempotent retry: same request id, same message → same tap.
        if (existing.body !== message.body) {
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
          and(eq(taps.senderId, senderId), gt(taps.createdAt, at - HOUR_MS))
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
        requestId: message.requestId,
        senderId,
        body: message.body,
        createdAt: at,
        state: "pending",
        sequence: row?.sequence ?? 0,
        theme,
        replies: message.replies ?? null,
      });
      return { id, isNew: true };
    })
  );

/** A stored tap as clients see it. Taps from before sender themes show Default. */
export const toTap = ({
  tap,
  senderName,
  senderColor,
}: {
  tap: typeof taps.$inferSelect;
  senderName: string;
  senderColor: typeof credentials.$inferSelect.color;
}): Tap => ({
  id: tap.id,
  senderId: tap.senderId,
  senderName,
  senderColor: senderColor ?? fallbackColor(tap.senderId),
  body: tap.body,
  createdAt: tap.createdAt,
  state: tap.state,
  displayedAt: tap.displayedAt,
  acknowledgedAt: tap.acknowledgedAt,
  acknowledgedBy: tap.acknowledgedBy,
  response: tap.response,
  sequence: tap.sequence,
  theme: tap.theme ?? "default",
  ...(tap.replies ? { replies: tap.replies } : {}),
});

/** Taps with their sender's name and color, newest first. */
export const readTaps = (
  db: EffectSQLiteDoDatabase,
  where: SQL | undefined,
  limit: number
) =>
  db
    .select({
      tap: taps,
      senderName: credentials.name,
      senderColor: credentials.color,
    })
    .from(taps)
    .innerJoin(credentials, eq(credentials.id, taps.senderId))
    .where(where)
    .orderBy(desc(taps.createdAt))
    .limit(limit)
    .pipe(Effect.map((rows) => rows.map(toTap)));
