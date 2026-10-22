import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";

/** How long a sign-in QR code works. It's shown on demand and used once. */
export const QR_SIGN_IN_SECONDS = 120;

const PLATFORMS = ["iphone", "mac", "windows", "web"] as const;
type Platform = (typeof PLATFORMS)[number];

const pendingKey = (hash: string) => `qr-sign-in:${hash}`;
const usedKey = (hash: string) => `qr-sign-in-used:${hash}`;

const hashToken = async (token: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return btoa(String.fromCodePoint(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const tokenFrom = (body: unknown): string => {
  const token =
    body && typeof body === "object" && "token" in body ? body.token : null;
  if (typeof token !== "string" || token.length === 0 || token.length > 128) {
    throw new APIError("BAD_REQUEST", { message: "Invalid code" });
  }
  return token;
};

const platformFrom = (body: unknown): Platform | null => {
  const platform =
    body && typeof body === "object" && "platform" in body
      ? body.platform
      : null;
  return PLATFORMS.find((p) => p === platform) ?? null;
};

const parse = (value: string): { userId?: string; platform?: string } => {
  try {
    return JSON.parse(value) as { userId?: string; platform?: string };
  } catch {
    return {};
  }
};

/**
 * Sign in a second device by scanning a QR code on one that's signed in
 * (docs/onboarding.md, "Sign in with a QR code"). The signed-in device creates
 * a code; the new device redeems it for its own session, so signing out of
 * one leaves the other signed in. Codes are random, hashed at rest, single
 * use and short-lived.
 */
export const qrSignIn = ({ webOrigin }: { webOrigin: string }) =>
  ({
    id: "qr-sign-in",
    endpoints: {
      createQrSignIn: createAuthEndpoint(
        "/qr-sign-in/create",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const token = generateRandomString(32, "a-z", "A-Z", "0-9");
          const expiresAt = new Date(Date.now() + QR_SIGN_IN_SECONDS * 1000);
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: pendingKey(await hashToken(token)),
            value: JSON.stringify({ userId: ctx.context.session.user.id }),
            expiresAt,
          });
          return ctx.json({
            token,
            url: `${webOrigin}/qr#${token}`,
            expiresAt: expiresAt.getTime(),
          });
        }
      ),
      qrSignInStatus: createAuthEndpoint(
        "/qr-sign-in/status",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const hash = await hashToken(tokenFrom(ctx.body));
          const userId = ctx.context.session.user.id;
          const { internalAdapter } = ctx.context;
          const used = await internalAdapter.findVerificationValue(
            usedKey(hash)
          );
          const usedBy = used ? parse(used.value) : {};
          if (used && usedBy.userId === userId) {
            return ctx.json({
              status: "used",
              platform: usedBy.platform ?? null,
            });
          }
          const pending = await internalAdapter.findVerificationValue(
            pendingKey(hash)
          );
          const live =
            pending &&
            pending.expiresAt > new Date() &&
            parse(pending.value).userId === userId;
          return ctx.json({
            status: live ? "pending" : "expired",
            platform: null,
          });
        }
      ),
      redeemQrSignIn: createAuthEndpoint(
        "/qr-sign-in/redeem",
        { method: "POST" },
        async (ctx) => {
          const hash = await hashToken(tokenFrom(ctx.body));
          const { internalAdapter } = ctx.context;
          const consumed = await internalAdapter.consumeVerificationValue(
            pendingKey(hash)
          );
          const userId = consumed ? parse(consumed.value).userId : undefined;
          const user = userId
            ? await internalAdapter.findUserById(userId)
            : null;
          if (!(consumed && user)) {
            throw new APIError("BAD_REQUEST", {
              message: "That code expired. Show a new one and scan again.",
            });
          }
          const session = await internalAdapter.createSession(user.id);
          await internalAdapter.createVerificationValue({
            identifier: usedKey(hash),
            value: JSON.stringify({
              userId: user.id,
              platform: platformFrom(ctx.body),
            }),
            expiresAt: new Date(Date.now() + QR_SIGN_IN_SECONDS * 1000),
          });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            token: session.token,
            user: { email: user.email },
          });
        }
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith("/qr-sign-in/"),
        window: 60,
        max: 30,
      },
    ],
  }) satisfies BetterAuthPlugin;
