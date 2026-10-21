import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { readAppearance, saveAppearance } from "../src/appearance";
import { migrate, open, withFile } from "./do-sqlite";

const NOW = Date.UTC(2026, 9, 21);

describe("the recipient's free appearance settings", () => {
  it("shows senders' themes with system motion for an inbox that never chose", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      migrate(sqlite);
      try {
        const shown = await Effect.runPromise(
          Effect.scoped(db.pipe(Effect.flatMap(readAppearance)))
        );
        expect(shown).toStrictEqual({ motion: "system", senderThemes: "show" });
      } finally {
        sqlite.close();
      }
    }));

  it("saves the plain override and reduced motion for anyone, keeping the other field, across restart", () =>
    withFile(async (path) => {
      const first = open(path);
      migrate(first.sqlite);
      const saved = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* save() {
            const d = yield* first.db;
            const plain = yield* saveAppearance(
              d,
              { senderThemes: "plain" },
              "mac_1",
              NOW
            );
            const motion = yield* saveAppearance(
              d,
              { motion: "reduced" },
              "pc_1",
              NOW + 1
            );
            return { plain, motion };
          })
        )
      );
      expect(saved).toStrictEqual({
        plain: { motion: "system", senderThemes: "plain" },
        motion: { motion: "reduced", senderThemes: "plain" },
      });
      first.sqlite.close();
      const reopened = open(path);
      try {
        const read = await Effect.runPromise(
          Effect.scoped(reopened.db.pipe(Effect.flatMap(readAppearance)))
        );
        expect(read).toStrictEqual({
          motion: "reduced",
          senderThemes: "plain",
        });
      } finally {
        reopened.sqlite.close();
      }
    }));

  it("keeps a row saved by the receiver-owned theme experiment, ignoring its old theme", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      migrate(sqlite, { through: "20261021162409_tap_appearance" });
      sqlite
        .prepare(
          "INSERT INTO appearance (id, theme, motion, updated_at, updated_by) VALUES (1, 'broadsheet', 'reduced', 0, 'mac_1')"
        )
        .run();
      migrate(sqlite, { after: "20261021162409_tap_appearance" });
      try {
        const read = await Effect.runPromise(
          Effect.scoped(db.pipe(Effect.flatMap(readAppearance)))
        );
        expect(read).toStrictEqual({ motion: "reduced", senderThemes: "show" });
      } finally {
        sqlite.close();
      }
    }));

  it("rejects a setting no client understands and a second row at the storage layer", () =>
    withFile((path) => {
      const { sqlite } = open(path);
      migrate(sqlite);
      try {
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO appearance (id, motion, sender_themes, updated_at, updated_by) VALUES (1, 'system', 'sparkly', 0, 'mac_1')"
            )
            .run()
        ).toThrow(/CHECK constraint failed: appearance_sender_themes/u);
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO appearance (id, motion, updated_at, updated_by) VALUES (2, 'system', 0, 'mac_1')"
            )
            .run()
        ).toThrow(/CHECK constraint failed: appearance_single_row/u);
      } finally {
        sqlite.close();
      }
    }));
});
