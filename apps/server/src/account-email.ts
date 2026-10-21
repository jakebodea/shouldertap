import { accountEmail, supportEmail } from "../../../domains.ts";
import { accountEmailTemplate } from "./account-email-template";

/** Cloudflare Email Service's builder API; injectable at the provider boundary. */
export interface AccountEmailBinding {
  send: (message: {
    from: { email: string; name: string };
    to: string;
    replyTo: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<unknown>;
}

export class AccountEmailUnavailableError extends Error {
  constructor() {
    // Provider errors can contain message bodies, including sign-in tokens.
    super("Sign-in email could not be sent. Please try again.");
    this.name = "AccountEmailUnavailableError";
  }
}

/**
 * Auth generates and validates links; this boundary only delivers them.
 * Never treat logging a token as successful delivery or expose provider errors.
 */
export const accountEmailSender =
  (binding?: AccountEmailBinding) =>
  async ({ email, url }: { email: string; url: string }): Promise<void> => {
    if (!binding) {
      throw new AccountEmailUnavailableError();
    }
    try {
      await binding.send({
        from: { email: accountEmail, name: "Shouldertap" },
        to: email,
        replyTo: supportEmail,
        subject: "Sign in to Shouldertap",
        ...accountEmailTemplate(url),
      });
    } catch {
      throw new AccountEmailUnavailableError();
    }
  };
