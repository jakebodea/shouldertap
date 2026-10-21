import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The Patron Durable Object's own SQLite: one sender's membership. Migrations
// live in `drizzle-patron` (`bun run db:generate:patron`). The billing facts
// and checkout reservation reuse the Inbox's table shapes, so the same
// lifecycle fold and storage functions serve both; the data never mixes,
// because each object has its own database.
export { patronCheckout, patronEvents } from "./schema";

/** One row: this identity's id and when it was made. */
export const patron = sqliteTable(
  "patron",
  {
    id: integer("id").primaryKey(),
    patronId: text("patron_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [check("patron_single_row", sql`${table.id} = 1`)]
);

/** One per device or browser the sender uses. Only the secret's hash is kept. */
export const patronKeys = sqliteTable("patron_keys", {
  id: text("id").primaryKey(),
  secretHash: text("secret_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
});

/** One-time codes, made by a key, that add another of the sender's devices. */
export const patronLinkCodes = sqliteTable("patron_link_codes", {
  id: text("id").primaryKey(),
  secretHash: text("secret_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  redeemedAt: integer("redeemed_at"),
});
