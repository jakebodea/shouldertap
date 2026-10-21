import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { initializeAccountIdentity, statusOf } from "../src/patron-identity";
import { open, migrate, withFile } from "./do-sqlite";

describe("account patron initialization", () => {
  it("is retryable and reserves no phantom device key", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      try {
        migrate(sqlite, { folder: "drizzle-patron" });
        const status = await Effect.runPromise(
          Effect.gen(function* readNewAccountPatron() {
            const database = yield* db;
            yield* initializeAccountIdentity(database, "account-patron", 1000);
            yield* initializeAccountIdentity(database, "account-patron", 2000);
            return yield* statusOf(database, 3000);
          })
        );
        expect(status).toStrictEqual({
          patronId: "account-patron",
          keys: 0,
          patron: {
            active: false,
            status: "none",
            paidUntil: null,
            canManage: false,
            canSubscribe: true,
            legacySupporter: false,
          },
        });
      } finally {
        sqlite.close();
      }
    }));
});
