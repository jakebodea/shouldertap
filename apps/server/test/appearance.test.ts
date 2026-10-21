import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { readAppearance, saveAppearance } from "../src/appearance";
import { patronOf } from "../src/patron";
import { storePatronEvent } from "../src/patron-storage";
import { migrate, open, withFile } from "./do-sqlite";

// Frozen clock: October 21, 2026, with a year of support paid through
// October 21, 2027.
const NOW = Date.UTC(2026, 9, 21);
const PAID_UNTIL = Date.UTC(2027, 9, 21);
const AFTER_LAPSE = Date.UTC(2027, 9, 22);

const paid = {
  id: "evt_paid",
  at: NOW,
  type: "subscription.paid",
  subscriptionId: "sub_1",
  customerId: "cust_1",
  periodEnd: PAID_UNTIL,
  transactionId: "tran_1",
  refundTransactionId: null,
};

const noPatron = patronOf([], NOW);

describe("tap appearance", () => {
  it("shows Default with system motion for an inbox that never chose", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      migrate(sqlite);
      try {
        const shown = await Effect.runPromise(
          Effect.scoped(
            db.pipe(Effect.flatMap((d) => readAppearance(d, noPatron)))
          )
        );
        expect(shown).toStrictEqual({
          theme: "default",
          shownTheme: "default",
          motion: "system",
          canChooseTheme: false,
        });
      } finally {
        sqlite.close();
      }
    }));

  it("lets anyone save reduced motion but refuses a theme without patron support", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      migrate(sqlite);
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* free() {
              const d = yield* db;
              const motion = yield* saveAppearance(
                d,
                { motion: "reduced" },
                "mac_1",
                NOW
              );
              const refused = yield* saveAppearance(
                d,
                { theme: "broadsheet" },
                "mac_1",
                NOW
              ).pipe(Effect.flip);
              return { motion, refused: refused.message };
            })
          )
        );
        expect(result).toStrictEqual({
          motion: {
            theme: "default",
            shownTheme: "default",
            motion: "reduced",
            canChooseTheme: false,
          },
          refused:
            "Tap themes are part of patron support. Default is always available.",
        });
        expect(
          sqlite
            .prepare("SELECT theme, motion, updated_by FROM appearance")
            .get()
        ).toMatchObject({
          theme: "default",
          motion: "reduced",
          updated_by: "mac_1",
        });
      } finally {
        sqlite.close();
      }
    }));

  it("keeps a patron's theme across restart, falls back to Default when support lapses, and never traps them", () =>
    withFile(async (path) => {
      const first = open(path);
      migrate(first.sqlite);
      const chosen = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* choose() {
            const d = yield* first.db;
            yield* storePatronEvent(d, paid);
            return yield* saveAppearance(
              d,
              { theme: "broadsheet" },
              "pc_1",
              NOW
            );
          })
        )
      );
      expect(chosen).toStrictEqual({
        theme: "broadsheet",
        shownTheme: "broadsheet",
        motion: "system",
        canChooseTheme: true,
      });
      first.sqlite.close();

      const reopened = open(path);
      try {
        const lapsed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* lapse() {
              const d = yield* reopened.db;
              const read = yield* readAppearance(
                d,
                patronOf([paid], AFTER_LAPSE)
              );
              const other = yield* saveAppearance(
                d,
                { theme: "terminal" },
                "pc_1",
                AFTER_LAPSE
              ).pipe(Effect.flip);
              const motion = yield* saveAppearance(
                d,
                { motion: "reduced" },
                "pc_1",
                AFTER_LAPSE
              );
              const back = yield* saveAppearance(
                d,
                { theme: "default" },
                "pc_1",
                AFTER_LAPSE
              );
              return { read, other: other._tag, motion, back };
            })
          )
        );
        expect(lapsed).toStrictEqual({
          // The choice is kept for when support resumes; screens show Default.
          read: {
            theme: "broadsheet",
            shownTheme: "default",
            motion: "system",
            canChooseTheme: false,
          },
          other: "Conflict",
          motion: {
            theme: "broadsheet",
            shownTheme: "default",
            motion: "reduced",
            canChooseTheme: false,
          },
          back: {
            theme: "default",
            shownTheme: "default",
            motion: "reduced",
            canChooseTheme: false,
          },
        });
      } finally {
        reopened.sqlite.close();
      }
    }));

  it("rejects a theme no client can render and a second settings row at the storage layer", () =>
    withFile((path) => {
      const { sqlite } = open(path);
      migrate(sqlite);
      try {
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO appearance (id, theme, motion, updated_at, updated_by) VALUES (1, 'neon', 'system', 0, 'mac_1')"
            )
            .run()
        ).toThrow(/CHECK constraint failed: appearance_theme/u);
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO appearance (id, theme, motion, updated_at, updated_by) VALUES (2, 'default', 'system', 0, 'mac_1')"
            )
            .run()
        ).toThrow(/CHECK constraint failed: appearance_single_row/u);
      } finally {
        sqlite.close();
      }
    }));
});
