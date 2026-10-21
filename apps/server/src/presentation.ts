import { parsePatronKey } from "@shouldertap/domain";
import type { ParsedPatronKey, TapTheme } from "@shouldertap/domain";
import * as Effect from "effect/Effect";

declare const verified: unique symbol;

/**
 * A theme the server may store on a tap. The Inbox only accepts this type,
 * never the request's `theme`, and the only way to make one other than
 * Default is `themeForSend` with a successful check of the SENDER's own
 * patron key. The recipient's membership, the sender's pairing credential and
 * anything else the client claims play no part.
 */
export type VerifiedTheme = TapTheme & { readonly [verified]: true };

export const DEFAULT_THEME = "default" as VerifiedTheme;

/**
 * Resolves what a send is stored with. Cosmetics never block delivery: a
 * missing, malformed, revoked or lapsed key stores the tap in Default rather
 * than refusing it, and the tap the sender gets back says so.
 */
export const themeForSend = <E, R>(
  requested: TapTheme | undefined,
  patronKey: string | undefined,
  isActivePatron: (key: ParsedPatronKey) => Effect.Effect<boolean, E, R>
): Effect.Effect<VerifiedTheme, never, R> => {
  if (!requested || requested === "default") {
    return Effect.succeed(DEFAULT_THEME);
  }
  const key = patronKey ? parsePatronKey(patronKey) : null;
  if (!key) {
    return Effect.succeed(DEFAULT_THEME);
  }
  return isActivePatron(key).pipe(
    Effect.map((active) =>
      active ? (requested as VerifiedTheme) : DEFAULT_THEME
    ),
    Effect.catchCause(() => Effect.succeed(DEFAULT_THEME))
  );
};
