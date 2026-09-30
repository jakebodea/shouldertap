import type {
  CredentialKind,
  PersonColor,
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

/** One row: this inbox's identity and its event sequence counter. */
export const inbox = sqliteTable("inbox", {
  id: integer("id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  recipientName: text("recipient_name").notNull(),
  sequence: integer("sequence").notNull().default(0),
});

/** Paired Macs ("device") and trusted senders ("sender"). */
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<CredentialKind>().notNull(),
  name: text("name").notNull(),
  /** Senders pick a frame color when they pair; Macs have none. */
  color: text("color").$type<PersonColor>(),
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
