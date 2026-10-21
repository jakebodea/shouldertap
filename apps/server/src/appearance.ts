import type {
  Appearance,
  MotionPreference,
  SenderThemePreference,
  UpdateAppearanceRequest,
} from "@shouldertap/domain";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import * as Effect from "effect/Effect";

import { appearance } from "./schema";

/**
 * The recipient's free settings for their own computers: motion, and whether
 * to show each tap in its sender's theme or always plain. Nothing here is
 * gated by billing, and nothing here chooses a theme: themes come from each
 * sender's tap.
 */
const DEFAULTS: Appearance = { motion: "system", senderThemes: "show" };

const savedRow = (db: EffectSQLiteDoDatabase) =>
  db
    .select({
      motion: appearance.motion,
      senderThemes: appearance.senderThemes,
    })
    .from(appearance)
    .pipe(Effect.map(([row]): Appearance => row ?? DEFAULTS));

export const readAppearance = (db: EffectSQLiteDoDatabase) => savedRow(db);

/** Saves a recipient device's change; any device, any time. */
export const saveAppearance = Effect.fn(function* saveAppearance(
  db: EffectSQLiteDoDatabase,
  request: UpdateAppearanceRequest,
  deviceId: string,
  at: number
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* save() {
      const current = yield* savedRow(tx);
      const next: {
        motion: MotionPreference;
        senderThemes: SenderThemePreference;
      } = {
        motion: request.motion ?? current.motion,
        senderThemes: request.senderThemes ?? current.senderThemes,
      };
      yield* tx
        .insert(appearance)
        .values({ id: 1, ...next, updatedAt: at, updatedBy: deviceId })
        .onConflictDoUpdate({
          target: appearance.id,
          set: { ...next, updatedAt: at, updatedBy: deviceId },
        });
      return next satisfies Appearance;
    })
  );
});
