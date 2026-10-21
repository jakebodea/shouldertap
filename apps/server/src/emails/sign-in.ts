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
