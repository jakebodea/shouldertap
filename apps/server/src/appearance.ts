import { Conflict } from "@shouldertap/domain";
import type {
  Appearance,
  MotionPreference,
  Patron,
  TapTheme,
  UpdateAppearanceRequest,
} from "@shouldertap/domain";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

import { patronOf } from "./patron";
import { appearance, patronEvents } from "./schema";

interface Saved {
  theme: TapTheme;
  motion: MotionPreference;
}

const DEFAULTS: Saved = { theme: "default", motion: "system" };

/**
 * What the recipient's computers show. Only active patron support shows a
 * saved theme; anything else (none, lapsed, refunded, paused) shows Default
 * and keeps the saved choice for when support resumes. Motion is always the
 * recipient's own, whatever the billing state.
 */
export const appearanceOf = (
  saved: Saved | undefined,
  patron: Patron
): Appearance => {
  const { theme, motion } = saved ?? DEFAULTS;
  return {
    theme,
    shownTheme: patron.active ? theme : "default",
    motion,
    canChooseTheme: patron.active,
  };
};

const patronNow = (db: EffectSQLiteDoDatabase, at: number) =>
  db
    .select()
    .from(patronEvents)
    .pipe(
      Effect.map((rows) =>
        patronOf(
          rows.map((r) => r.event),
          at
        )
      )
    );

const savedRow = (db: EffectSQLiteDoDatabase) =>
  db
    .select({ theme: appearance.theme, motion: appearance.motion })
    .from(appearance)
    .pipe(Effect.map((rows) => rows[0]));

export const readAppearance = Effect.fn(function* readAppearance(
  db: EffectSQLiteDoDatabase,
  patron: Patron
) {
  return appearanceOf(yield* savedRow(db), patron);
});

/**
 * Saves a recipient device's change in one transaction with the entitlement
 * check. Default and motion are always allowed, so nobody is ever stuck on a
 * theme; choosing another theme needs active patron support at `at`.
 */
export const saveAppearance = Effect.fn(function* saveAppearance(
  db: EffectSQLiteDoDatabase,
  request: UpdateAppearanceRequest,
  deviceId: string,
  at: number
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* save() {
      const patron = yield* patronNow(tx, at);
      const current = (yield* savedRow(tx)) ?? DEFAULTS;
      const next: Saved = {
        theme: request.theme ?? current.theme,
        motion: request.motion ?? current.motion,
      };
      if (
        request.theme !== undefined &&
        request.theme !== "default" &&
        !patron.active
      ) {
        return yield* new Conflict({
          message:
            "Tap themes are part of patron support. Default is always available.",
        });
      }
      yield* tx
        .insert(appearance)
        .values({ id: 1, ...next, updatedAt: at, updatedBy: deviceId })
        .onConflictDoUpdate({
          target: appearance.id,
          set: { ...next, updatedAt: at, updatedBy: deviceId },
        });
      return appearanceOf(next, patron);
    })
  );
});
