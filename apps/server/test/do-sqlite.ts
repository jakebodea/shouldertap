import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

import * as SqliteDo from "@effect/sql-sqlite-do/SqliteClient";
import * as Drizzle from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

/** Fake only Cloudflare's storage boundary; run the production Effect/Drizzle
 * queries and transactions against a real file-backed SQLite database. */
export const open = (path: string) => {
  const sqlite = new DatabaseSync(path);
  const storage = {
    sql: {
      exec(query: string, ...params: SQLInputValue[]) {
        const statement = sqlite.prepare(query);
        const columns = statement.columns().map((c) => c.name);
        const rows = statement.all(...params);
        return {
          columnNames: columns,
          raw: () => rows.map((row) => columns.map((c) => row[c])),
        };
      },
    },
    transactionSync<A>(f: () => A): A {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const value = f();
        sqlite.exec("COMMIT");
        return value;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const db = Drizzle.makeWithDefaults({ storage }).pipe(
    Effect.provide(SqliteDo.layer({ db: storage.sql }))
  );
  return { sqlite, db };
};

/**
 * Applies committed migrations in order, as a Durable Object does on
 * activation: the Inbox's (`drizzle`) by default, or the SenderPatron's
 * (`drizzle-patron`). `through` stops after that migration, to set up data
 * the way an older server stored it; `after` then applies the rest.
 */
export const migrate = (
  sqlite: DatabaseSync,
  {
    folder = "drizzle",
    through,
    after,
  }: {
    folder?: "drizzle" | "drizzle-patron";
    through?: string;
    after?: string;
  } = {}
) => {
  const dir = new URL(`../${folder}/`, import.meta.url);
  for (const name of readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .filter((entry) => !through || entry <= through)
    .filter((entry) => !after || entry > after)) {
    sqlite.exec(
      readFileSync(new URL(`${name}/migration.sql`, dir), "utf-8").replaceAll(
        "--> statement-breakpoint",
        ""
      )
    );
  }
};

export const withFile = async (f: (path: string) => Promise<void> | void) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "shouldertap-patron-"));
  try {
    await f(nodePath.join(dir, "inbox.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
