import { ApiError } from "@shouldertap/client";

/** Pure pieces of the sign-in, invite and accept flow (docs/onboarding.md). */

export const CODE_LENGTH = 6;

const NON_DIGITS = /\D/gu;

/** What a code field holds after typing or pasting: up to six digits. */
export const otpDigits = (value: string) =>
  value.replace(NON_DIGITS, "").slice(0, CODE_LENGTH);

/** Where sign-in may send the person afterwards: a path on this site. */
export const safeRedirect = (value?: unknown): string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.startsWith("/\\")
    ? value
    : "/tap";

/** A pasted invite: the full link (code after "#") or just the code. */
export const codeFromPaste = (value: string) => {
  const trimmed = value.trim();
  const hash = trimmed.indexOf("#");
  try {
    return decodeURIComponent(
      hash === -1 ? trimmed : trimmed.slice(hash + 1)
    ).trim();
  } catch {
    return "";
  }
};

/** The code from a scanned invite link, or null for any other QR code. */
export const codeFromScan = (value: string) => {
  try {
    const url = new URL(value);
    return url.pathname === "/join" && url.hash.length > 1
      ? codeFromPaste(value)
      : null;
  } catch {
    return null;
  }
};

/** The link an invite is shared as; the code rides in the fragment. */
export const inviteLink = (origin: string, code: string) =>
  `${origin}/join#${encodeURIComponent(code)}`;

const BROWSERS = [
  ["Edg/", "Edge"],
  ["Firefox/", "Firefox"],
  ["FxiOS/", "Firefox"],
  ["CriOS/", "Chrome"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
] as const;

const SYSTEMS = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Windows", "Windows"],
  ["Macintosh", "Mac"],
  ["CrOS", "ChromeOS"],
  ["Linux", "Linux"],
] as const;

/**
 * How this browser is listed among the account's devices, e.g. "Safari on
 * iPhone". iPadOS reports itself as a Mac; a touch screen gives it away.
 */
export const browserDeviceName = (userAgent: string, maxTouchPoints = 0) => {
  const browser =
    BROWSERS.find(([marker]) => userAgent.includes(marker))?.[1] ?? "Browser";
  let system = SYSTEMS.find(([marker]) => userAgent.includes(marker))?.[1];
  if (system === "Mac" && maxTouchPoints > 1) {
    system = "iPad";
  }
  return system ? `${browser} on ${system}` : browser;
};

/**
 * A phone has no other phone to sign in with: its Shouldertap app hands
 * this browser a session instead (`/account#<token>`).
 */
export const isPhoneBrowser = (userAgent: string) =>
  /iPhone|Android.+Mobile/u.test(userAgent);

export const OFFLINE_MESSAGE =
  "Couldn't reach Shouldertap. Check your connection and try again.";

/** What to say when a step fails: the server's words, unless it's offline. */
export const failureMessage = (error: unknown) =>
  error instanceof ApiError && error.code !== "network" && error.message
    ? error.message
    : OFFLINE_MESSAGE;

/** A wrong or expired code answers 400; anything else keeps its wording. */
export const codeFailureMessage = (error: unknown) =>
  error instanceof ApiError && error.status === 400
    ? "That code didn't work. Check it or send a new one."
    : failureMessage(error);
