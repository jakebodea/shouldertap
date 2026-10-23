import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { bearer, deviceAuthorization, emailOTP } from "better-auth/plugins";

import { accountCodeSender } from "./account-email";
import type { AccountEmailBinding } from "./account-email";
import { qrSignIn } from "./qr-sign-in";

export interface AccountAuthOptions {
  database: BetterAuthOptions["database"];
  secret: string;
  origin: string;
  webOrigin?: string;
  email?: AccountEmailBinding;
  /** Told about each new account, after it's stored (analytics). */
  onAccountCreated?: (user: { id: string; createdAt: Date }) => Promise<void>;
}

export const accountAuthOptions = ({
  database,
  secret,
  origin,
  webOrigin,
  email,
  onAccountCreated,
}: AccountAuthOptions) =>
  ({
    appName: "Shouldertap",
    baseURL: origin,
    basePath: "/api/auth",
    database,
    secret,
    trustedOrigins: webOrigin ? [origin, webOrigin] : [origin],
    logger: { disabled: true },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    user: { deleteUser: { enabled: true } },
    databaseHooks: onAccountCreated
      ? { user: { create: { after: (user) => onAccountCreated(user) } } }
      : undefined,
    plugins: [
      // Every client signs in with a code typed (or autofilled) in the app
      // itself, or with a QR code: a signed-in device shows one for a new
      // device to scan (qrSignIn), or a new device shows its device
      // authorization code for a signed-in phone to approve.
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        rateLimit: { window: 60, max: 3 },
        sendVerificationOTP: async ({ email: recipient, otp, type }) => {
          if (type !== "sign-in") {
            return;
          }
          await accountCodeSender(email)({ email: recipient, code: otp });
        },
      }),
      deviceAuthorization({
        // A phone camera opens the website's account page to approve.
        verificationUri: `${webOrigin ?? origin}/account/device`,
        expiresIn: "10m",
        interval: "5s",
        validateClient: (clientId) =>
          [
            "shouldertap-ios",
            "shouldertap-mac",
            "shouldertap-windows",
            "shouldertap-web",
          ].includes(clientId),
      }),
      qrSignIn({ webOrigin: webOrigin ?? origin }),
      bearer(),
    ],
  }) satisfies BetterAuthOptions;

export const createAccountAuth = (options: AccountAuthOptions) =>
  betterAuth(accountAuthOptions(options));
