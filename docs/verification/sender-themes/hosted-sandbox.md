# Sender-owned patron sandbox verification — October 21, 2026

Verified in the assigned shared checkout, branch `t3/sustainable-free-business-model`. Application commit **`4e1311928e893c2dfda818db2bf1e8513fd2a2b8`** was deployed through Alchemy to the existing **`patron-sandbox`** stage. The final deployment finished at 18:29:07 UTC. Alchemy reported one updated server; the web assets were unchanged from the first integrated deployment at 18:18:05 UTC. This is deployment-command evidence; the API does not expose an embedded revision endpoint.

- API: `https://shouldertap-server-patron-sandbox-plz4iniwxkqzrwox.jakebodea.workers.dev`.
- Web: `https://shouldertap-web-patron-sandbox-kq2oa2cdzwe6ryen.jakebodea.workers.dev`.
- Command: `bun alchemy deploy --stage patron-sandbox --profile default --yes --no-input`.
- Test product: `prod_4fniZfXS6ZbXHuZTQRb4M0`; provider read-back verified `mode: test`, active, USD 2400, recurring `every-year`, no trial. Only its description and default success URL changed. The copy now explains sender-owned styles across pairings, free recipients and messaging, $2/month billed $24 annually plus tax, renewal/cancellation, no permanent theme ownership/future pack promise, and native iPhone Default-only sending.
- Existing test webhook `wh_test_1IU4rA9oVsy1HVNyU0sai1` and its ten events were retained. Dashboard mode switch was `aria-checked=true` before operating the test delivery log. No new keys, secrets, webhooks, providers or accounts were created. Production was neither deployed nor modified; no push, PR or merge.

## Code fixes

All fixes are at the **code layer**, with checks where relevant:

1. Checkout supplies the documented Creem SDK `successUrl` to the current API origin's `/v1/patrons/return`. The return page reflects no query values and has `no-store`, `no-referrer` and restrictive CSP headers. It grants no membership and explains both new-tab and same-tab return. SDK-boundary test asserts the literal serialized `success_url` and `patron_id`, with no `inbox_id`. The hosted harness visits a forged paid redirect and verifies the membership remains inactive.
2. Patron link codes expire **at** the 15-minute boundary (`expiresAt <= now`), rather than one millisecond later. The SQLite behavior test now checks exactly that boundary.
3. iOS Help's website Support link appears only after StoreKit confirms `USA`, follows storefront updates and fails closed on unknown storefronts. Other storefronts retain email support. Native iPhone sending remains Default; no StoreKit purchase product or paid native feature was added.
4. The hosted signed-fixture harness now checks two independent sender styles in one free inbox, cross-inbox entitlement, revoked/malformed/lapsed fallback, free plain/reduced controls, immutable history and idempotent retries. Continuation credentials are written only to an owner-only temporary file.

## Actual provider payment and lifecycle

The user manually completed the **one already-prepared sender checkout**, after its hosted page showed test-only/no-charge mode and $24/year. No second payment was needed. This was a new sender-owned checkout, separate from every historical receiver-model purchase and every synthetic fixture.

| Scenario | Actual observed result |
| --- | --- |
| Checkout and ownership | Creem retrieval returned `completed`, `mode: test`, the correct product, `metadata.patron_id` matching the browser's identity, **no `inbox_id`**, and the exact return URL above. The expanded subscription independently retained the same patron metadata. |
| Paid subscription | Provider subscription `sub_3dYkFCCtYKf0slJzvDZovN` was active, with paid transaction `tran_h41psMAgwJ3KPeLhWpZ2s`. Period end `2027-10-21T18:23:24.075Z` matched Shouldertap's `paidUntil: 1824143004075`. `GET /v1/patrons/me` returned active, canManage true, canSubscribe false. No synthetic event was sent for this patron. |
| Signed delivery | Test webhook dashboard showed actual `checkout.completed` event `evt_6yWuQkLN2uBjZy7TofQeSj` and `subscription.paid` event `evt_4ENow2HxcrgpWMWS4VGW83`: Delivered, HTTP 200, response `ok`. The server's only billing mutation path verifies the raw-body signature. |
| Cross-pairing paid benefit | One actual provider-paid patron key sent Broadsheet taps to **two newly created free recipient inboxes**. Each recipient snapshot independently reported patron inactive and the accepted tap's theme `broadsheet`. Neither recipient checked out. |
| Free receiver overrides | Both recipients saved `senderThemes: plain`, `motion: reduced` without paying. Snapshots retained those settings and the immutable Broadsheet tap fact. This proves hosted settings/protocol behavior; native screen rendering is covered separately by existing renderer tests/local evidence, not a new native end-to-end run. |
| Actual hosted UI | Real API responses, no stubs: the original sender's Style page became active after payment, enabled Broadsheet selection, saved it, and returned to the original draft. The draft survived the checkout's same-tab fallback and sent successfully in Broadsheet. Sender snapshot and visible history agreed. After the real refund, the same composer delivered a requested Broadsheet tap as Default, visibly reported “Sent in Default”, and retained the earlier Broadsheet tap. |
| Billing portal | Authenticated `POST /v1/patrons/me/manage` generated the actual customer's hosted test portal. It showed Test Mode, Shouldertap Patron, $24, payment history and Update Payment Details/Cancel Subscription controls. No payment-method change was made. |
| Portal cancellation | Canceled through Manage Order → Cancel Subscription → confirmation. Provider became `canceled`; Shouldertap became `ending`, active, with the same paidUntil. A new Note tap still stored `note`. Event `evt_6rEcLDQTSS31pdSmxYhlmn` delivered HTTP 200/`ok`. |
| Full refund | Supported test SDK refund requested for the exact paid transaction, initially pending, then provider transaction retrieval confirmed `refunded`. Event `evt_2cPg1uo9zR2zXWlRF3Ztwr` delivered HTTP 200/`ok`. Shouldertap became inactive, paidUntil 0, canSubscribe true; subscription remained canceled. |
| Actual paid-event replay after refund | Dashboard Resend on the original paid delivery created provider event `evt_26AZ63f9AxPqivVm3uf6uS`: Delivered, HTTP 200/`ok`. Subsequent API checks still returned inactive, paidUntil 0, canSubscribe true. |
| New and existing taps after refund | Both recipient pairings still delivered new taps, stored as Default despite requesting Terminal with the refunded patron key. Both original Broadsheet taps remained Broadsheet. Retrying each original request id/body with a different requested theme returned the same tap id and original Broadsheet theme. |

Hosted URLs, patron keys, pairing tokens, customer portal URLs and customer information remain in mode-0600 files under `/tmp/shouldertap-sender-sandbox-20261021` (mode 0700). Do not paste their contents into logs. `provider-checkout.json` is the payment-time snapshot; final lifecycle was independently reread after cancellation/refund/replay. The original `/tmp/shouldertap-patron-sandbox-20261021` state belongs to the obsolete receiver model and was not reused.

## Signed synthetic fixtures and UI

`bun scripts/check-patron-sandbox.ts --signed-fixtures` passed against the hosted final application. These are **locally signed synthetic events**, not additional provider purchases, annual renewals or failure simulations.

- Invalid signature rejected; checkout-completed alone grants nothing; paid activates; duplicate does not extend the literal paid boundary.
- One sender's membership styles taps to two inboxes. Another sender's own active membership produces a different style in the same recipient inbox. Receiver billing is absent during this check.
- Malformed and revoked keys deliver Default. A paid boundary before the real Worker clock delivers Default. Local frozen-clock tests cover exact membership expiry.
- Cancellation retains paid-through styling; refund removes entitlement; late and new-identity paid replays cannot restore refunded payment. Refund-before-unseen-paid remains sticky. Refunding an older transaction cannot erase a later renewal.
- Past-due/unpaid/expired events cannot extend paid time; pause suppresses styling and a later paid event restores it; scheduled cancel ends after the paid boundary.
- Plain/reduced receiver settings save for free without mutating stored tap themes. Existing taps and same-request retries retain the theme accepted while entitled.
- Historical `inbox_id` subscription routes to its Inbox for management and grants senders no theme. Free sending and text replies work after refund.
- Separate hosted UI fixture: nonpatron previews/replays Broadsheet with their real draft but Use is disabled. A different patron activated synthetically through the real webhook has enabled Use, saved style, preserved draft and matching sender/recipient snapshot themes. No API responses were stubbed.
- Final disposable synthetic inbox: `efe3cabf801a40188e7e3e4dad858556`; patron `141a621cba4a4869aa15dafc7389f90c`.

T3 snapshot failed with `Preview automation snapshot timed out after 15000ms.` Main-frame T3 evaluation worked for reading/clicking the real hosted UI, checkout, portal and dashboard. Original local screenshots remain unchanged and explicitly labeled archived/stubbed where applicable.

## Validation and remaining boundaries

- `bun run check`, `bun run check-types`, `bun run test`: passed, **129 unit tests** (61 root, 56 server, 8 domain, 4 client).
- Hosted general integration: **9 passed**. Final signed-fixture harness passed after the committed application's deployment; actual refunded-patron state was also checked again afterward.
- `swift test`: **57 passed**. `cargo test -p shouldertap-core`: **42 passed** (27 unit and 15 integration). Generic iOS Simulator build: **BUILD SUCCEEDED**. No simulator was created or booted, so none needed shutdown. No new native hardware, Windows-host or storefront-runtime UI verification is claimed.
- **All-keys-lost recovery is unavailable.** Existing keys can issue one-time device link codes; no key means no supported authenticated recovery operation. The inspected Creem primitives provide merchant-authenticated customer/subscription lookup and portal generation, not proof that the requester controls that customer. The portal has its own magic-link authentication but no verified buyer-authentication callback into Shouldertap was established. No recovery endpoint/operator bypass was added, no subscription was reassigned, and a supplied email/customer id is never accepted as identity proof. Support can cancel/refund; it cannot currently restore a lost identity.
- Real annual renewal, failed renewal/payment recovery, partial refunds, native themed sending on iPhone, self-service lost-key recovery and App Review remain unverified/unbuilt. Payment-method controls were visible but not exercised. Merchant approval and live product copy remain launch gates. The API return endpoint and provider successUrl were verified; automated capture of the user's actual post-payment redirect was not available, and no entitlement claim relies on it.
- Official sources checked: [Creem SDK successUrl](https://docs.creem.io/code/sdks/typescript), [customer portal](https://docs.creem.io/features/customer-portal), [webhook delivery/replay](https://docs.creem.io/code/webhooks), [Apple 3.1.1(a)/3.1.3](https://developer.apple.com/app-store/review/guidelines/). The US-only link boundary is an implementation decision based on those rules, not a claim of App Review approval.
