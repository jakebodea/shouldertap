import { and, isNotNull, lt, sql } from "drizzle-orm";

import { activityTokens, credentials, invites, taps, tickets } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Taps (with their replies) are deleted this long after they were sent. */
export const TAP_RETENTION_MS = 90 * DAY_MS;
/** Expired invites linger a day so opening the link late still says "expired". */
export const INVITE_GRACE_MS = DAY_MS;
/** Removed pairings are deleted once none of their taps remain. */
export const REVOKED_RETENTION_MS = TAP_RETENTION_MS;

/**
 * What the daily retention pass deletes as of `now`, table by table. Delete
 * in this order: taps first, so a removed sender's last taps no longer hold its
 * credential row (taps join to it for the sender's name and color).
 *
 * The inbox's `sequence` counter is never touched: it only grows, so a
 * client that resyncs after a deletion still orders every remaining update
 * and simply stops seeing the deleted taps in its next snapshot.
 */
export const retentionFilters = (now: number) => ({
  taps: lt(taps.createdAt, now - TAP_RETENTION_MS),
  invites: lt(invites.expiresAt, now - INVITE_GRACE_MS),
  tickets: lt(tickets.expiresAt, now),
  revokedCredentials: and(
    isNotNull(credentials.revokedAt),
    lt(credentials.revokedAt, now - REVOKED_RETENTION_MS),
    sql`NOT EXISTS (SELECT 1 FROM ${taps} WHERE ${taps.senderId} = ${credentials.id})`
  ),
  /** Live Activity tokens whose tap is gone (answered taps drop theirs at once). */
  activityTokens: sql`NOT EXISTS (SELECT 1 FROM ${taps} WHERE ${taps.id} = ${activityTokens.tapId})`,
});
