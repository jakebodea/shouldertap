import { sendEmail } from "./emails/delivery";
import type { EmailBinding } from "./emails/delivery";
import { signInCodeEmail } from "./emails/sign-in";

export type AccountEmailBinding = EmailBinding;

export class AccountEmailUnavailableError extends Error {
  constructor() {
    // Provider errors can contain message bodies, including sign-in codes.
    super("Sign-in email could not be sent. Please try again.");
    this.name = "AccountEmailUnavailableError";
  }
}

/**
 * The emailed sign-in code every client uses. Auth generates and validates
 * codes; this boundary only delivers them. Never log a code or expose
 * provider errors.
 */
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
