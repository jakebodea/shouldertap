import type { EmailContent } from "./layout";

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
