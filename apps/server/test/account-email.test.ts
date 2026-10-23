import { describe, expect, it } from "vitest";

import { accountCodeSender } from "../src/account-email";
import type { AccountEmailBinding } from "../src/account-email";
import { renderEmail } from "../src/emails/layout";

describe("account sign-in email", () => {
  it("delivers the sign-in code from Shouldertap with support replies", async () => {
    const messages: Parameters<AccountEmailBinding["send"]>[0][] = [];
    const send = accountCodeSender({
      send: (message) => {
        messages.push(message);
        return Promise.resolve({ messageId: "email-1" });
      },
    });
    await send({ email: "reader@example.com", code: "482913" });
    expect(messages).toStrictEqual([
      {
        from: { email: "signin@mail.shouldertap.app", name: "Shouldertap" },
        to: "reader@example.com",
        replyTo: "support@shouldertap.app",
        subject: "482913 is your Shouldertap code",
        html: expect.stringContaining("482913"),
        text: expect.stringContaining("482913"),
      },
    ]);
  });

  it("fails closed when delivery is not configured", async () => {
    await expect(
      accountCodeSender()({ email: "reader@example.com", code: "482913" })
    ).rejects.toThrow("Sign-in email could not be sent. Please try again.");
  });

  it("does not expose provider errors containing sign-in codes", async () => {
    const send = accountCodeSender({
      send: () => Promise.reject(new Error("Provider rejected 482913")),
    });
    await expect(
      send({ email: "reader@example.com", code: "482913" })
    ).rejects.toMatchObject({
      name: "AccountEmailUnavailableError",
      message: "Sign-in email could not be sent. Please try again.",
    });
  });
});

describe("email rendering", () => {
  it("escapes an action URL in HTML while preserving the plain-text link", async () => {
    const email = await renderEmail({
      subject: "Open Shouldertap",
      preview: "Open Shouldertap.",
      heading: "Hello.",
      paragraphs: ["Open Shouldertap."],
      action: {
        label: "Open Shouldertap",
        url: 'https://shouldertap.app/account#token&"<test>',
      },
      footer: "Thanks.",
    });
    expect(email.html).toContain(
      'href="https://shouldertap.app/account#token&amp;&quot;&lt;test&gt;"'
    );
    expect(email.text).toContain(
      'https://shouldertap.app/account#token&"<test>'
    );
  });
});
