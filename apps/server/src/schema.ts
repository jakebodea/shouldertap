import type {
  CredentialKind,
  DevicePlatform,
  PersonColor,
  PushEnvironment,
  TapResponse,
  TapState,
} from "@shouldertap/domain";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** One row: this inbox's identity, event sequence counter and plan. */
export const inbox = sqliteTable("inbox", {
  id: integer("id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  recipientName: text("recipient_name").notNull(),
  sequence: integer("sequence").notNull().default(0),
  /** Taps stop being delivered after this unless the inbox is paid for. */
  trialEndsAt: integer("trial_ends_at"),
  /** Set by Creem's checkout.completed webhook; cleared by a refund. */
  paidAt: integer("paid_at"),
  orderId: text("order_id"),
  /** The buyer's email, kept to restore the purchase on a new Mac. */
  purchaseEmail: text("purchase_email"),
});

/** Linked Macs and iPhones ("device") and trusted senders ("sender"). */
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<CredentialKind>().notNull(),
  name: text("name").notNull(),
  /** Senders pick a frame color when they pair; devices have none. */
  color: text("color").$type<PersonColor>(),
  /** Devices only: a Mac or an iPhone. Null for senders. */
  platform: text("platform").$type<DevicePlatform>(),
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
  },
  (table) => [
    uniqueIndex("taps_sender_request").on(table.senderId, table.requestId),
    index("taps_created_at").on(table.createdAt),
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
