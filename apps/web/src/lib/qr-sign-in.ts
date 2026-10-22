import { qrSignInToken } from "@shouldertap/client";
import type {
  AccountClient,
  AccountPlatform,
  DeviceSignIn,
  DeviceSignInPoll,
  QrSignIn,
  QrSignInStatus,
} from "@shouldertap/client";

/**
 * Pure pieces of signing in with a QR code (docs/onboarding.md, "Sign in
 * with a QR code"): the browser shows one for a phone to scan, or signs in
 * by a phone scanning the browser's.
 */

/** How often a shown sign-in QR code checks whether it was scanned. */
export const QR_STATUS_EVERY_MS = 2000;

/** The token in `/qr#<token>`'s fragment, or null for anything else. */
export const qrTokenFromFragment = (hash: string) =>
  qrSignInToken(`shouldertap://qr#${hash.replace(/^#/u, "")}`);

/** Opens the iPhone app on the same sign-in code. */
export const appLink = (token: string) => `shouldertap://qr#${token}`;

const DEVICE_NAMES: Record<AccountPlatform, string> = {
  iphone: "iPhone",
  mac: "Mac",
  windows: "PC",
  web: "browser",
};

/** "Signed in on your {iPhone|Mac|PC|browser}". */
export const signedInOn = (platform: AccountPlatform | null) =>
  `Signed in on your ${platform ? DEVICE_NAMES[platform] : "phone"}`;

/** Computer → phone: the code this browser shows a phone to scan. */
export type ShowQr =
  | { readonly kind: "making" }
  | { readonly kind: "showing"; readonly qr: QrSignIn }
  | { readonly kind: "used"; readonly platform: AccountPlatform | null }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

/** After one status check: the server says whether it was used or expired. */
export const afterQrStatus = (
  shown: ShowQr & { kind: "showing" },
  status: QrSignInStatus
): ShowQr => {
  switch (status.status) {
    case "used": {
      return { kind: "used", platform: status.platform };
    }
    case "expired": {
      return { kind: "expired" };
    }
    default: {
      return shown;
    }
  }
};

/**
 * A status check that didn't get through keeps the code up until it has
 * expired by this browser's clock too.
 */
export const afterQrStatusFailed = (
  shown: ShowQr & { kind: "showing" },
  now: number
): ShowQr => (now >= shown.qr.expiresAt ? { kind: "expired" } : shown);

/** Phone → computer: this browser waiting for a phone to approve it. */
export type ScanFromPhone =
  | { readonly kind: "starting" }
  | {
      readonly kind: "waiting";
      readonly started: DeviceSignIn;
      /** Seconds until the next poll. */
      readonly interval: number;
    }
  | { readonly kind: "signing-in"; readonly token: string }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

/** After one poll of the device sign-in. */
export const afterDevicePoll = (
  waiting: ScanFromPhone & { kind: "waiting" },
  poll: DeviceSignInPoll,
  now: number
): ScanFromPhone => {
  switch (poll.kind) {
    case "signed-in": {
      return { kind: "signing-in", token: poll.token };
    }
    case "denied": {
      return { kind: "denied" };
    }
    case "expired": {
      return { kind: "expired" };
    }
    default: {
      return now >= waiting.started.expiresAt
        ? { kind: "expired" }
        : { ...waiting, interval: poll.interval };
    }
  }
};

/**
 * The browser keeps its session only in an HttpOnly cookie, so it trades the
 * bearer token a phone approved for one: a QR sign-in made with the bearer,
 * redeemed with cookies, then the bearer session ends. Signing out the bearer
 * is best effort; the browser is signed in either way.
 */
export const tradeBearerForCookie = async (
  bearer: AccountClient,
  cookie: AccountClient
) => {
  const qr = await bearer.createQrSignIn();
  const signedIn = await cookie.redeemQrSignIn(qr.token, "web");
  await bearer.signOut().catch(() => null);
  return signedIn;
};
