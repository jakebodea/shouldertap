import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  INVITE_GRACE_MS,
  REVOKED_RETENTION_MS,
  retentionFilters,
  TAP_RETENTION_MS,
} from "../src/retention";
import { credentials, invites, taps, tickets } from "../src/schema";

const MIGRATIONS = path.join(import.meta.dir, "../drizzle");
const NOW = Date.UTC(2026, 9, 1);
const MIGRATION_DIR = /^\d/u;

/** The Inbox's schema, from the same migrations the Durable Object applies. */
const freshDb = () => {
  const sqlite = new Database(":memory:");
  for (const dir of readdirSync(MIGRATIONS)
    .filter((d) => MIGRATION_DIR.test(d))
    .toSorted()) {
    const migration = readFileSync(
      path.join(MIGRATIONS, dir, "migration.sql"),
      "utf-8"
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return drizzle({ client: sqlite });
};

const credential = (id: string, revokedAt: number | null) => ({
  id,
  kind: "sender" as const,
  name: id,
  secretHash: "x",
  createdAt: 0,
  revokedAt,
});

const tap = (
  id: string,
  senderId: string,
  createdAt: number,
  sequence: number
) => ({
  id,
  requestId: id,
  senderId,
  body: id,
  createdAt,
  state: "acknowledged" as const,
  sequence,
});

const invite = (id: string, expiresAt: number) => ({
  id,
  kind: "sender" as const,
  secretHash: "x",
  createdBy: "mac",
  createdAt: 0,
  expiresAt,
});

/** Runs the deletes in the same order as the Inbox's alarm. */
const prune = (db: ReturnType<typeof freshDb>, now: number) => {
  const filters = retentionFilters(now);
  db.delete(taps).where(filters.taps).run();
  db.delete(invites).where(filters.invites).run();
  db.delete(tickets).where(filters.tickets).run();
  db.delete(credentials).where(filters.revokedCredentials).run();
};

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).toSorted();

describe("retention", () => {
  test("deletes taps older than 90 days and keeps newer ones", () => {
    const db = freshDb();
    db.insert(credentials).values(credential("sam", null)).run();
    db.insert(taps)
      .values([
        tap("old", "sam", NOW - TAP_RETENTION_MS - 1, 1),
        tap("edge", "sam", NOW - TAP_RETENTION_MS, 2),
        tap("new", "sam", NOW - 1000, 3),
      ])
      .run();
    prune(db, NOW);
    expect(ids(db.select().from(taps).all())).toEqual(["edge", "new"]);
    // Remaining taps keep their sequence numbers; nothing is renumbered.
    expect(
      db
        .select()
        .from(taps)
        .all()
        .map((t) => t.sequence)
        .toSorted()
    ).toEqual([2, 3]);
  });

  test("deletes invites a day after expiry, and expired tickets", () => {
    const db = freshDb();
    db.insert(invites)
      .values([
        invite("long-gone", NOW - INVITE_GRACE_MS - 1),
        invite("just-expired", NOW - 1000),
        invite("live", NOW + 1000),
      ])
      .run();
    db.insert(tickets)
      .values([
        {
          id: "spent",
          secretHash: "x",
          credentialId: "sam",
          expiresAt: NOW - 1,
        },
        {
          id: "fresh",
          secretHash: "x",
          credentialId: "sam",
          expiresAt: NOW + 1,
        },
      ])
      .run();
    prune(db, NOW);
    expect(ids(db.select().from(invites).all())).toEqual([
      "just-expired",
      "live",
    ]);
    expect(ids(db.select().from(tickets).all())).toEqual(["fresh"]);
  });

  test("deletes long-removed pairings only once their taps are gone", () => {
    const db = freshDb();
    const longAgo = NOW - REVOKED_RETENTION_MS - 1;
    db.insert(credentials)
      .values([
        credential("active", null),
        credential("recently-removed", NOW - 1000),
        credential("removed-no-taps", longAgo),
        credential("removed-old-taps", longAgo),
        credential("removed-recent-tap", longAgo),
      ])
      .run();
    db.insert(taps)
      .values([
        tap("t1", "removed-old-taps", NOW - TAP_RETENTION_MS - 1, 1),
        tap("t2", "removed-recent-tap", NOW - 1000, 2),
      ])
      .run();
    prune(db, NOW);
    expect(ids(db.select().from(credentials).all())).toEqual([
      "active",
      "recently-removed",
      "removed-recent-tap",
    ]);
  });
});
