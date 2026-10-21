import {
  MOTION_PREFERENCES,
  SENDER_THEME_PREFERENCES,
  TAP_THEMES,
} from "@shouldertap/domain";
import type {
  CredentialKind,
  DevicePlatform,
  MotionPreference,
  PersonColor,
  PushEnvironment,
  SenderThemePreference,
  TapResponse,
  TapState,
  TapTheme,
} from "@shouldertap/domain";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { PatronEvent } from "./patron";

/** One row: this inbox's identity, event sequence counter and plan. */
export const inbox = sqliteTable("inbox", {
  id: integer("id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  recipientName: text("recipient_name").notNull(),
  sequence: integer("sequence").notNull().default(0),
  /** Historical trial metadata, no longer enforces access. */
  trialEndsAt: integer("trial_ends_at"),
  /** Set by Creem's checkout.completed webhook; cleared by a refund. */
  paidAt: integer("paid_at"),
  orderId: text("order_id"),
  /** The buyer's email, kept to restore the purchase on a new Mac. */
  purchaseEmail: text("purchase_email"),
  /** Retired: the recipient support prompt's history. Kept, no longer written. */
  firstAnsweredAt: integer("first_answered_at"),
  answeredCount: integer("answered_count").notNull().default(0),
  supportAskAfter: integer("support_ask_after").notNull().default(0),
});

/** Signed provider facts. In an Inbox these are historical receiver-owned
 * subscriptions (checkout metadata `inbox_id`), kept so they can still be
 * managed, canceled and refunded; they grant nothing. In a Patron they are the
 * sender's own membership (metadata `patron_id`). */
export const patronEvents = sqliteTable("patron_events", {
  id: text("id").primaryKey(),
  event: text("event", { mode: "json" }).$type<PatronEvent>().notNull(),
});

/** One outstanding checkout per billing subject. An uncertain
 * provider response stays reserved rather than risking a second subscription. */
export const patronCheckout = sqliteTable("patron_checkout", {
  id: integer("id").primaryKey(),
  requestId: text("request_id").notNull(),
  createdAt: integer("created_at").notNull(),
  url: text("url"),
  providerId: text("provider_id"),
});

export const refundedOrders = sqliteTable("refunded_orders", {
  id: text("id").primaryKey(),
});

/** `'a', 'b'` for a CHECK constraint over a fixed set of literals. */
const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * At most one row: the recipient's free settings for their own computers. No
 * row means senders' themes shown, system motion. `theme` is retired: it held
 * the receiver-owned theme experiment's choice, which no longer affects
 * anything (themes now come from each sender's tap).
 */
export const appearance = sqliteTable(
  "appearance",
  {
    id: integer("id").primaryKey(),
    theme: text("theme").$type<TapTheme>().notNull().default("default"),
    motion: text("motion")
      .$type<MotionPreference>()
      .notNull()
      .default("system"),
    senderThemes: text("sender_themes")
      .$type<SenderThemePreference>()
      .notNull()
      .default("show"),
    updatedAt: integer("updated_at").notNull(),
    /** The device credential that last changed it. */
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    check("appearance_single_row", sql`${table.id} = 1`),
    check("appearance_theme", sql`${table.theme} in (${oneOf(TAP_THEMES)})`),
    check(
      "appearance_motion",
      sql`${table.motion} in (${oneOf(MOTION_PREFERENCES)})`
    ),
    check(
      "appearance_sender_themes",
      sql`${table.senderThemes} in (${oneOf(SENDER_THEME_PREFERENCES)})`
    ),
  ]
);

/** Linked Macs and iPhones ("device") and trusted senders ("sender"). */
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<CredentialKind>().notNull(),
  name: text("name").notNull(),
  /** Senders pick a frame color when they pair; devices have none. */
  color: text("color").$type<PersonColor>(),
  /** Devices only: a Mac or an iPhone. Null for senders. */
  platform: text("platform").$type<DevicePlatform>(),
  parentId: text("parent_id"),
  /** Device-key unlinking is separate from recipient removal of a sender. */
  keyRevokedAt: integer("key_revoked_at"),
  secretHash: text("secret_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<CredentialKind>().notNull(),
  secretHash: text("secret_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  redeemedAt: integer("redeemed_at"),
});

/** One-time WebSocket connect tickets. */
export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  secretHash: text("secret_hash").notNull(),
  credentialId: text("credential_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const taps = sqliteTable(
  "taps",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    senderId: text("sender_id").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
    state: text("state").$type<TapState>().notNull(),
    displayedAt: integer("displayed_at"),
    acknowledgedAt: integer("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    response: text("response", { mode: "json" }).$type<TapResponse>(),
    sequence: integer("sequence").notNull(),
    /** The sender's theme, fixed when the tap was accepted. Null on taps from
     * before sender themes, which show Default. */
    theme: text("theme").$type<TapTheme>(),
  },
  (table) => [
    uniqueIndex("taps_sender_request").on(table.senderId, table.requestId),
    index("taps_created_at").on(table.createdAt),
    check(
      "taps_theme",
      sql`${table.theme} IS NULL OR ${table.theme} in (${oneOf(TAP_THEMES)})`
    ),
  ]
);

/** A linked iPhone's push setup: one row per device credential. */
export const pushRegistrations = sqliteTable("push_registrations", {
  credentialId: text("credential_id").primaryKey(),
  environment: text("environment").$type<PushEnvironment>().notNull(),
  topic: text("topic").notNull(),
  deviceToken: text("device_token"),
  startToken: text("start_token"),
  liveActivities: integer("live_activities", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** The Live Activity a tap started on each iPhone, so answering ends it. */
export const activityTokens = sqliteTable(
  "activity_tokens",
  {
    tapId: text("tap_id").notNull(),
    credentialId: text("credential_id").notNull(),
    token: text("token").notNull(),
  },
  (table) => [
    uniqueIndex("activity_tokens_tap_device").on(
      table.tapId,
      table.credentialId
    ),
  ]
);
