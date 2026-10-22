import type { EmailContent } from "./layout";

export const signInEmail = (url: string): EmailContent => ({
  subject: "Sign in to Shouldertap",
  preview: "Your sign-in link is ready. It expires in 10 minutes.",
  heading: "A little closer.",
  paragraphs: [
    "Sign in to your Shouldertap account to pick up where you left off.",
  ],
  action: { label: "Sign in to Shouldertap", url },
  note: "This link expires in 10 minutes and can be used once.",
  footer: "Didn't ask to sign in? You can ignore this email.",
});

/** The code leads the subject, so it shows in the notification and iOS can
 * offer it above the keyboard. */
export const signInCodeEmail = (code: string): EmailContent => ({
  subject: `${code} is your Shouldertap code`,
  preview: "Enter it in Shouldertap to sign in. It expires in 10 minutes.",
  heading: "Your sign-in code",
  paragraphs: ["Enter this code in Shouldertap to sign in."],
  code,
  note: "It expires in 10 minutes. Never share it with anyone.",
  footer: "Didn't ask to sign in? You can ignore this email.",
});
