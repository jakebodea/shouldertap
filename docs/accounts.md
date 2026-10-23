# Email accounts

One email account covers inboxes, sending connections, and patron membership. A Mac is not required. Purchases stay on the web; no in-app purchases.

## Email and infrastructure

The installed Alchemy Cloudflare Email APIs are the infrastructure source of truth.

- `alchemy.run.ts` declares the production `mail.shouldertap.app` sending subdomain. Cloudflare provisions its authentication records. Message previews are disabled because email bodies contain sign-in tokens.
- The production API's `ACCOUNT_EMAIL` binding allows only `signin@mail.shouldertap.app`. Replies go to the existing `support@shouldertap.app` route. Preview Workers have no sending binding.
- `Server.ts` declares the Accounts D1 database, versioned `account-migrations`, and persisted Alchemy account secret. No Resend credential is used.
- Missing bindings and provider failures reject delivery without logging links or provider error details.

## Sign-in and recovery

Every client signs in the same way: the person enters their email, gets a six-digit code (Better Auth `emailOTP`: 10-minute expiry, three wrong tries, hashed at rest, rotated on resend, code in the subject so iOS can offer it from Mail), and types it into the app. Native apps keep the returned session token in their vault and send it as a bearer; the browser gets an HttpOnly cookie from the same response. The flow and endpoints are in [onboarding](onboarding.md).

The account is the person. Its profile (name and color, `account_profile`) is asked once; saving it creates the person's inbox with no device. `/account/sync` links a device: it saves the tokens the device already holds to the account, issues a device credential for the person's inbox when the device receives, and issues the device its own sender key for each connection it lacks. Accepting an invite (`/account/accept`) connects both people: a sender in the inviter's inbox for the person accepting and one in theirs for the inviter, each with that person's profile. The two Inbox objects share no transaction, so the reverse half is created first and revoked if redeeming the invite fails.

There is one account page, the website's `/account` (with `/account/device` for approving a device's code). The API origin serves no pages. The iPhone app opens it signed in: it makes a one-time QR sign-in code and puts it in the fragment (`/account?intent=patron#<token>`), which the page redeems for this browser before loading. Phone browsers don't offer "Sign in with your phone".

Existing Inbox and SenderPatron credentials remain valid. Signing in does not prove ownership of an existing inbox or purchase. Saving a device's credentials requires both a verified email session and the valid credentials; another account's resources cannot be adopted (sync skips them).

Accounts that adopted several inboxes keep them separate; the default (else the first) is the person's inbox. Restoration issues independently revocable device keys. Unlinking a sender device preserves the other devices and account recovery; recipient removal revokes the entire sender connection.

## Patron funnel and deletion

Browser and Mac patron entrypoints lead through account sign-in, adoption of existing membership, and membership resolution before checkout. iPhone purchase links use the actual US App Store storefront, never device locale. Native device-authorization pages hide purchase controls.

The legacy bearer-only signup endpoint redirects users through the account flow. Existing membership management remains available: the web page opens checkout and the billing portal itself (`POST /account/patron/checkout|manage`), and checkout returns to `/account?intent=patron`. Pages read the public `GET /v1/patrons/availability` and offer checkout when Creem credentials and the annual patron product are configured. Otherwise they say "Patron memberships open soon". The web account page remembers a patron intent for an hour across the email round trip; it never replaces a different membership already in the browser, and a returning patron adds the account's membership with one explicit "Use membership on this browser" action.

Checkout checks every account membership, pins one billing identity, and serializes checkout, adoption, and deletion. Active subscriptions and unresolved checkout attempts block account deletion so billing access is retained. Deleting an account removes account sessions and recovery references; it does not remove existing messaging credentials.

Operation locks deliberately have no expiry: after an interrupted Worker operation, operator reconciliation is required before clearing its lock. Do not unlock a checkout until the provider and patron state establish whether payment can still complete.

## Verification and rollout

Unit tests cover sign-in code expiry and attempts, device authorization, ownership, and revocation. Local Alchemy HTTP/D1/DO checks cover multiple inboxes, restoration, device unlinking, recipient revocation, and cross-account denial. Native builds and core tests are separate gates.

Production deployment, sending-domain activation, and delivery to a real mailbox require separate verification. A successful infrastructure plan or local sign-in test does not establish production delivery. Native account features also require new distributed builds; this change does not submit an iOS release to App Review.
