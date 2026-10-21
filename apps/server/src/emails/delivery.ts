import { accountEmail, supportEmail } from "../../../../domains.ts";
import { renderEmail } from "./layout";
import type { EmailContent } from "./layout";

/** Cloudflare's provider boundary; application callers supply content, never raw HTML. */
export interface EmailBinding {
  send: (message: {
    from: { email: string; name: string };
    to: string;
    replyTo: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<unknown>;
}

export const sendEmail = async (
  binding: EmailBinding,
  to: string,
  content: EmailContent
) => {
  await binding.send({
    from: { email: accountEmail, name: "Shouldertap" },
    to,
    replyTo: supportEmail,
    ...(await renderEmail(content)),
  });
};
