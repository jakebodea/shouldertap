import { verificationStageCreatedAt } from "../../../scripts/cloudflare/previews.ts";
import type { AccountEmailBinding } from "./account-email";
import { verificationPushResponse } from "./verification-push";

/** Only explicitly allocated verification stages may acquire a capture mailbox. */
export const isVerificationStage = (stage: string) =>
  verificationStageCreatedAt(stage) !== undefined;

export interface VerificationMailbox {
  database: D1Database;
  token: string;
}

/** Delivery is replaced; OTP generation, validation and account sessions stay real. */
export const captureAccountEmail = (
  database: D1Database
): AccountEmailBinding => ({
  async send(message) {
    await database
      .prepare(
        "INSERT INTO verification_mail (recipient, subject, body, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(recipient) DO UPDATE SET subject = excluded.subject, body = excluded.body, received_at = excluded.received_at"
      )
      .bind(message.to.toLowerCase(), message.subject, message.text, Date.now())
      .run();
  },
});

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });

/** Called only when the deployment has a verification-only mailbox binding. */
export const verificationMailResponse = async (
  request: Request,
  mailbox: VerificationMailbox
): Promise<Response> => {
  const url = new URL(request.url);
  // No CORS: only the runner, never application JavaScript, can read codes.
  if (
    url.pathname !== "/__verify/mail" ||
    mailbox.token.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${mailbox.token}`
  ) {
    return json({ error: "Not found" }, 404);
  }
  if (!["GET", "DELETE"].includes(request.method)) {
    return json({ error: "Method not allowed" }, 405);
  }
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes("@")) {
    return json({ error: "Email required" }, 400);
  }
  if (request.method === "DELETE") {
    await mailbox.database
      .prepare("DELETE FROM verification_mail WHERE recipient = ?")
      .bind(email)
      .run();
    return json({ cleared: true });
  }
  const message = await mailbox.database
    .prepare(
      "SELECT recipient AS 'to', subject, body AS text FROM verification_mail WHERE recipient = ? AND received_at > ?"
    )
    .bind(email, Date.now() - 600_000)
    .first<{ to: string; subject: string; text: string }>();
  return message ? json(message) : json({ error: "Not found" }, 404);
};

/** Routes exist only in deployments that acquired verification-only bindings. */
export const verificationResponse = (
  request: Request,
  mailbox: VerificationMailbox
) =>
  new URL(request.url).pathname === "/__verify/push"
    ? verificationPushResponse(request, mailbox)
    : verificationMailResponse(request, mailbox);

/** Keep Cloudflare's actual limiter while separating each stage's client budget. */
export const stageRateLimitKey = (stage: string, address: string) =>
  `${stage}:${address}`;

/** Only an authenticated verification runner may simulate a distinct network client. */
export const verificationRateLimitKey = (
  stage: string,
  address: string,
  headers: Readonly<Record<string, string | undefined>>,
  verificationToken?: string
) => {
  const identity = headers["x-shouldertap-verification-client"];
  if (
    isVerificationStage(stage) &&
    verificationToken &&
    verificationToken.length >= 32 &&
    headers["x-shouldertap-verification-token"] === verificationToken &&
    identity &&
    /^[a-zA-Z0-9-]{1,80}$/u.test(identity)
  ) {
    return stageRateLimitKey(stage, `verification:${identity}`);
  }
  return stageRateLimitKey(stage, address);
};
