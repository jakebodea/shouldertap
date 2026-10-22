import { sendEmail } from "./emails/delivery";
import type { EmailBinding } from "./emails/delivery";
import { signInCodeEmail, signInEmail } from "./emails/sign-in";

export type AccountEmailBinding = EmailBinding;

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
      await sendEmail(binding, email, signInEmail(url));
    } catch {
      throw new AccountEmailUnavailableError();
    }
  };

/** The emailed sign-in code every client uses. Same failure rules as links. */
export const accountCodeSender =
  (binding?: AccountEmailBinding) =>
  async ({ email, code }: { email: string; code: string }): Promise<void> => {
    if (!binding) {
      throw new AccountEmailUnavailableError();
    }
    try {
      await sendEmail(binding, email, signInCodeEmail(code));
    } catch {
      throw new AccountEmailUnavailableError();
    }
  };
