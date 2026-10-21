# Email accounts

One email account covers inboxes, sending connections, and patron membership. A Mac is not required. Purchases stay on the web; no in-app purchases.

## Email and infrastructure

The installed Alchemy Cloudflare Email APIs are the infrastructure source of truth.

- `alchemy.run.ts` declares the production `mail.shouldertap.app` sending subdomain. Cloudflare provisions its authentication records. Message previews are disabled because email bodies contain sign-in tokens.
- The production API's `ACCOUNT_EMAIL` binding allows only `signin@mail.shouldertap.app`. Replies go to the existing `support@shouldertap.app` route. Preview Workers have no sending binding.
- `Server.ts` declares the Accounts D1 database, versioned `account-migrations`, and persisted Alchemy account secret. No Resend credential is used.
- Missing bindings and provider failures reject delivery without logging links or provider error details.

## Sign-in and recovery

Better Auth stores hashed, single-use sign-in tokens, ten-minute expiry, database rate limits, and sessions in D1. Email links put the token in the fragment; the account page clears it and requires explicit confirmation before exchanging it. The public GET verification route is disabled.

Native apps use device authorization: the user approves the matching code in the browser, and the app stores its resulting session in Keychain. The app shows the code before the person opens the browser, and `AccountStore` owns the polling task, so closing the Mac popover or iPhone sheet doesn't cancel sign-in. A device request opens a portal page with only the code check. Browser sessions use cookies with exact-origin credentialed CORS. Signing out leaves local messaging credentials intact.

Existing Inbox and SenderPatron credentials remain valid. Signing in does not prove ownership of an existing inbox or purchase. Saving this device requires both a verified email session and its valid credentials; another account's resources cannot be adopted.

Multiple inboxes remain separate. Owners can select a default and switch without deleting or silently merging them. Native switching preserves the old inbox credential and reuses valid saved credentials. Restoration issues independently revocable device keys. Unlinking a sender device preserves the other devices and account recovery; recipient removal revokes the entire sender connection.

## Patron funnel and deletion

Browser and Mac patron entrypoints lead through account sign-in, adoption of existing membership, and membership resolution before checkout. iPhone purchase links use the actual US App Store storefront, never device locale. Native device-authorization pages hide purchase controls.

The legacy bearer-only signup endpoint redirects users through the account flow. Existing membership management remains available. `PATRON_CHECKOUT_ENABLED` stays off until merchant and product readiness are confirmed. Pages read the public `GET /v1/patrons/availability` (the flag plus a configured product) and say "Patron memberships open soon" instead of offering checkout while it is off. The web account page remembers a patron intent for an hour across the email round trip; it never replaces a different membership already in the browser, and a returning patron adds the account's membership with one explicit "Use membership on this browser" action.

Checkout checks every account membership, pins one billing identity, and serializes checkout, adoption, and deletion. Active subscriptions and unresolved checkout attempts block account deletion so billing access is retained. Deleting an account removes account sessions and recovery references; it does not remove existing messaging credentials.

Operation locks deliberately have no expiry: after an interrupted Worker operation, operator reconciliation is required before clearing its lock. Do not unlock a checkout until the provider and patron state establish whether payment can still complete.

## Verification and rollout

Unit tests cover sign-in expiry/replay, device authorization, ownership, and revocation. Local Alchemy HTTP/D1/DO checks cover multiple inboxes, restoration, device unlinking, recipient revocation, and cross-account denial. Native builds and core tests are separate gates.

Production deployment, sending-domain activation, and delivery to a real mailbox require separate verification. A successful infrastructure plan or local sign-in test does not establish production delivery. Native account features also require new distributed builds; this change does not submit an iOS release to App Review.
