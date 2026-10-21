import { describe, expect, it } from "vitest";

import { accountEmailSender } from "../src/account-email";
import type { AccountEmailBinding } from "../src/account-email";

describe("account sign-in email", () => {
  it("delivers the sign-in link from Shouldertap with support replies", async () => {
    const messages: Parameters<AccountEmailBinding["send"]>[0][] = [];
    const send = accountEmailSender({
      send: (message) => {
        messages.push(message);
        return Promise.resolve({ messageId: "email-1" });
      },
    });
    await send({
      email: "reader@example.com",
      url: "https://shouldertap.app/account/verify?token=example",
    });
    expect(messages).toStrictEqual([
      {
        from: { email: "signin@mail.shouldertap.app", name: "Shouldertap" },
        to: "reader@example.com",
        replyTo: "support@shouldertap.app",
        subject: "Sign in to Shouldertap",
        text: "Sign in to your Shouldertap account:\n\nhttps://shouldertap.app/account/verify?token=example\n\nThis link expires in 10 minutes and works once. If it has expired, request a new one.\n\nIf you didn't request this email, you can ignore it.",
      },
    ]);
  });

  it("fails closed when delivery is not configured", async () => {
    await expect(
      accountEmailSender()({
        email: "reader@example.com",
        url: "secret",
      })
    ).rejects.toThrow("Sign-in email could not be sent. Please try again.");
  });

  it("does not expose provider errors containing sign-in tokens", async () => {
    const send = accountEmailSender({
      send: () =>
        Promise.reject(new Error("Provider rejected secret-token-value")),
    });
    await expect(
      send({ email: "reader@example.com", url: "secret-token-value" })
    ).rejects.toMatchObject({
      name: "AccountEmailUnavailableError",
      message: "Sign-in email could not be sent. Please try again.",
    });
  });
});
