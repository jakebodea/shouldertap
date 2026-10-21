import { describe, expect, it } from "vitest";

import { sendEmail } from "../src/emails/delivery";
import type { EmailBinding } from "../src/emails/delivery";
import { renderEmail } from "../src/emails/layout";

const announcement = {
  subject: "A note from Shouldertap",
  preview: "Something new for your next tap.",
  heading: "Hello, Alex & Sam",
  paragraphs: [
    "Your next tap has a little more color.",
    "Thanks for being here.",
  ],
  footer: "You're receiving this because you asked for product updates.",
};

describe("shared branded email delivery", () => {
  it("brands non-sign-in mail and derives a readable text alternative from its content", async () => {
    const messages: Parameters<EmailBinding["send"]>[0][] = [];
    await sendEmail(
      {
        send: (message) => {
          messages.push(message);
          return Promise.resolve();
        },
      },
      "reader@example.com",
      announcement
    );
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.subject).toBe("A note from Shouldertap");
    expect(message?.html).toContain("Hello, Alex &amp; Sam");
    expect(message?.html).toContain("#2546db");
    expect(message?.text).toMatch(
      /Shouldertap[\s\S]*Your next tap has a little more color\.[\s\S]*Thanks for being here\.[\s\S]*You're receiving this because you asked for product updates\./u
    );
  });

  it("escapes supplied copy without treating it as HTML", async () => {
    const result = await renderEmail({
      ...announcement,
      heading: '<script>alert("x")</script>',
    });
    expect(result.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
    expect(result.text).toContain('<SCRIPT>ALERT("X")</SCRIPT>');
  });

  it("rejects executable action URLs before rendering", async () => {
    // An intentionally malicious URL verifies that email actions reject script schemes.
    // eslint-disable-next-line no-script-url
    const unsafeUrl = "javascript:alert(1)";
    await expect(
      renderEmail({
        ...announcement,
        action: { label: "Open", url: unsafeUrl },
      })
    ).rejects.toThrow(
      "Email actions must use HTTPS or local development URLs."
    );
  });
});
