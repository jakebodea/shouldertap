import { describe, expect, it } from "vitest";

import { accountEmailSender } from "../src/account-email";
import type { AccountEmailBinding } from "../src/account-email";
import { accountEmailTemplate } from "../src/account-email-template";

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
      url: "https://api.shouldertap.app/account#example",
    });
    expect(messages).toStrictEqual([
      {
        from: { email: "signin@mail.shouldertap.app", name: "Shouldertap" },
        to: "reader@example.com",
        replyTo: "support@shouldertap.app",
        subject: "Sign in to Shouldertap",
        html: expect.stringContaining(
          'href="https://api.shouldertap.app/account#example"'
        ),
        text: "Sign in to your Shouldertap account:\n\nhttps://api.shouldertap.app/account#example\n\nThis link expires in 10 minutes and can be used once.\n\nIf you didn't request this email, you can ignore it.",
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

describe("email rendering", () => {
  it("escapes the sign-in URL in HTML while preserving the plain-text link", () => {
    const email = accountEmailTemplate(
      'https://api.shouldertap.app/account#token&"<test>'
    );
    expect(email.html).toContain(
      'href="https://api.shouldertap.app/account#token&amp;&quot;&lt;test&gt;"'
    );
    expect(email.text).toContain(
      'https://api.shouldertap.app/account#token&"<test>'
    );
    expect(email.html).toContain("This link expires in 10 minutes");
    expect(email.html).toContain("Sign in to Shouldertap");
  });
});
