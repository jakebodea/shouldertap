import { AccountClient, ApiError } from "@shouldertap/client";
import type { Me } from "@shouldertap/client";

import { browserDeviceName } from "@/lib/onboarding";
import { applySync, syncTokens } from "@/lib/pairing";
import { tradeBearerForCookie } from "@/lib/qr-sign-in";

/** Account calls go to the API origin with this browser's session cookie. */
export const account = new AccountClient({
  baseUrl: import.meta.env.VITE_SERVER_URL,
});

/**
 * Signs this browser in with the session a phone approved (device sign-in),
 * moving it into the cookie; returns who signed in.
 */
export const signInWithApprovedSession = async (sessionToken: string) => {
  await tradeBearerForCookie(
    new AccountClient({
      baseUrl: import.meta.env.VITE_SERVER_URL,
      sessionToken,
    }),
    account
  );
  return account.me();
};

/** How this browser appears among the account's devices. */
export const thisDevice = () =>
  browserDeviceName(navigator.userAgent, navigator.maxTouchPoints);

export type Session =
  | { readonly kind: "signed-in"; readonly me: Me }
  | { readonly kind: "signed-out" }
  /** The server couldn't be reached; local pairings still work. */
  | { readonly kind: "offline" };

export const loadSession = async (): Promise<Session> => {
  try {
    const me = await account.session();
    return me ? { kind: "signed-in", me } : { kind: "signed-out" };
  } catch {
    return { kind: "offline" };
  }
};

/** Signed in, but the You step (name and color) hasn't happened yet. */
export const needsSignIn = (session: Session) =>
  session.kind === "signed-out" ||
  (session.kind === "signed-in" && session.me.profile === null);

/**
 * Saves this browser's keys to the account and picks up keys for everyone
 * the account can tap. A browser never receives, so it asks for no inbox.
 */
export const syncThisBrowser = async () => {
  const result = await account.sync({
    platform: "web",
    deviceName: thisDevice(),
    receive: false,
    tokens: syncTokens(),
  });
  applySync(result);
  return result;
};

/** The session ended or the profile is missing: sign in again. */
export const isSignedOutError = (error: unknown) =>
  error instanceof ApiError &&
  (error.code === "unauthorized" || error.code === "conflict");
