# Shouldertap emails

All application emails use `sendEmail(binding, recipient, content)` from `delivery.ts`. Supply an `EmailContent` definition (see `sign-in.ts`); the shared React Email layout supplies the brand, accessible email components, safe text escaping, and matching plain-text alternative. Optional actions must use HTTPS (HTTP is allowed only on loopback for local development). Keep provider bindings at this delivery boundary.

Sign-in is currently the only application-triggered email. Adding this shared layout does not subscribe people to marketing or introduce new email triggers. Billing-provider receipts and manually written support replies are outside this renderer.

Cloudflare still delivers the rendered HTML/text through the Alchemy-managed email binding. React Email is the component/rendering library, not a change of email provider. System fonts are intentional for email-client compatibility.
