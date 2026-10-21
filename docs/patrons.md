# Free core and optional patrons

Implementation as of October 21, 2026. The application code has local verification but is not deployed. Matching sandbox/live products and the live webhook are configured; see the verified provider setup below for the exact boundary.

Core sending, receiving, replies, pairing and recipient controls are free. The existing safety limits remain: 30 taps per sender per rolling hour, 20 active senders and 10 active devices per inbox. No limit depends on payment.

Optional support costs **US$24/year**, described as **$2/month, billed $24 annually**, plus applicable tax. It renews annually until canceled. Support helps cover running costs; it does not unlock messaging, appearance packs or promised rewards, and is not a tax-deductible donation. There are no third-party ads, sponsors or business tier.

## Compatibility and storage

- Every device snapshot retains the original plan shape and emits `status: paid`, even for an expired/refunded/nonpaying inbox. This is a compatibility value so older desktops do not present a paywall or pause messages. It is not purchase evidence. Actual legacy `paid_at`, `order_id`, `purchase_email` and trial dates are preserved separately. Existing buyers are thanked and not auto-enrolled.
- `POST /v1/checkout` no longer sells anything. Authenticated devices get a Conflict explaining free use and the app update. An old “Unlock for $5” button can never silently open the annual checkout. Updated Swift/Rust clients use `POST /v1/patron/checkout`. Old servers return 404 for that route; new clients never fall back to the one-time purchase endpoint.
- Web outboxes retire persisted billing-pause banners while preserving failed drafts and requiring a deliberate retry; old messages are never auto-sent.
- `patron` is an additive optional field on device snapshots; sender snapshots never expose billing state. Swift and Rust tolerate absent/malformed optional fields from old/new servers. The server remains authoritative.
- The additive `20261021152554_free_core_patrons` migration stores event facts, checkout reservations, legacy refund tombstones and prompt history. It does not rewrite old purchase columns or delete trials. New setup ignores the fingerprint older clients still send; no new TrialLedger claims are made.
- Membership follows the paired inbox, across its devices. There are still no user accounts or automatic cross-inbox purchase restoration. Lost-pairing or billing recovery needs support and provider verification, not a new charge.

## Checkout and lifecycle

The installed official `creem` SDK is 1.13.0. Product retrieval must confirm an active USD 2400 recurring `every-year` product with no trial or metered usage before creation. Legacy and patron product IDs are distinct configuration values. The inbox ID is checkout metadata (`inbox_id`), copied by Creem to subscription metadata. `request_id` is correlation, not assumed provider idempotency.

A durable transaction reserves one checkout per inbox, shared across devices. Pending checkouts reuse their URL. The provider's `expired` status permits a new attempt; processing/completed checkout status waits for the webhook. A network failure during creation leaves a reservation with no URL, because retrying an uncertain request could create a second subscription. SDK automatic retries are disabled. An operator must reconcile this exceptional case: find the checkout by the reservation's request ID in Creem, save its ID/URL if it exists, or clear that exact reservation only after confirming no payable checkout exists. Do not clear a reservation just because time has elapsed.

`/v1/webhooks/creem` verifies the raw body with the configured signing secret before decoding. Invalid signatures get 400; storage/provider/recognized-payload failures get 500 for retry. Unrelated products/events get 200 without mutation. Bare subscription IDs on refunds and missing subscription metadata are resolved through supported subscription retrieval, not guessed from URLs.

The immutable fact ledger deduplicates event IDs. It folds by provider event time with conservative tie ordering, independently for each subscription:

- `subscription.paid` alone extends the paid period, on first payment or renewal. `checkout.completed` is not proof of an annual payment; it still handles outstanding historical one-time checkouts for the legacy product.
- `subscription.active` synchronizes state without extending paid time.
- `subscription.scheduled_cancel` and `subscription.canceled` stop renewal UI while patron status remains through the paid period. It ends exactly at the paid boundary, even without a final webhook. Core messaging continues.
- `subscription.past_due`, `subscription.unpaid` and `subscription.expired` never extend paid time. Payment recovery uses the customer portal; a later paid event recovers support. `subscription.paused` suppresses active patron status.
- A succeeded `refund.created` removes the corresponding transaction's paid period, including a partial refund. It cannot revoke a later paid renewal or resurrect a refunded payment when delivered out of order. Refunds do not automatically cancel future renewal: manage/cancel that subscription too.
- Legacy refunds leave a durable order tombstone, so late purchase retries cannot restore the refunded purchase marker. No refund affects free-core access.

`POST /v1/patron/manage` authenticates a device and generates Creem's hosted customer portal using the stored customer ID. Creem's current portal docs say portal cancellation stops the subscription immediately; Shouldertap retains patron status through the paid period. The code also accepts scheduled cancellation events. Both surfaces describe canceling renewal and keeping the paid period. Active/recovering subscriptions must be managed before starting another; a completed cancellation permits a fresh annual checkout.

## Promotion policy

Support is always discoverable in the Mac menu, Windows menu, iPhone Help and linked Inbox, and web support/footer. Mac and Windows details are collapsed by default. There is no sender prompt and no iPhone automatic purchase prompt.

Only the Mac recipient menu claims the optional experience-based ask. Eligibility requires ten successfully committed tap answers and 14 elapsed days since the first answer. The first eligible idle menu opening consumes a **90-day cooldown** in the inbox transaction, whether the user dismisses, ignores or opens checkout. “Not now” dismisses locally; the claimed cooldown is already durable across restarts and every paired device. The server refuses a claim while any tap is pending. The Mac also hides it while an overlay/reply is active. It is nonmodal and never appears in an overlay or pairing screen. Current/former patrons and historical purchasers receive no automatic asks. New post-migration answers establish eligibility; retained/deleted history is not used to manufacture it.

## External setup still required

### Provider setup verified October 21, 2026

- Created **Shouldertap Patron** in both Creem modes: USD $24, yearly subscription, active, no trial, metered charges, delivery/license benefits, cart-recovery emails or affiliate enrollment. Applicable tax is added on top. The description states optional support, annual renewal and free core use; no appearance rewards are promised.
- Sandbox product: `prod_4fniZfXS6ZbXHuZTQRb4M0`. Saved and read back as `CREEM_PATRON_PRODUCT_ID` in Infisical `shouldertap-dev` / `dev`.
- Live product: `prod_5UUHvLxlV78jkf0VB9waDy`. Saved and read back as `CREEM_PATRON_PRODUCT_ID` in Infisical `shouldertap-prod` / `prod`.
- Existing API keys were verified by mode without exposing values: dev uses a test key, prod uses a live key. The existing production webhook secret remains unchanged.
- Updated existing live webhook `wh_15vMN3FyfbGIi1WKJzOP4E` (**Shouldertap prod API**, `https://api.shouldertap.app/v1/webhooks/creem`) to the ten events listed below, retaining the original checkout/refund events. Verified the saved endpoint and event list.
- Creem showed a stale test-mode banner even in live mode. Mode was verified using the actual mode switch (`aria-checked=true` means test), distinct product catalogs and their distinct product IDs; do not infer mode from that banner alone.
- No purchases, test payments, charges, deployments or changes to the old product were made. The live product exists but the app does not yet expose the new checkout. Do not advertise its direct payment link before the server rollout and validation.

Still outstanding: sandbox has no webhook endpoint or signing secret. Create these against the actual deployed development/test stack (not the production URL), save the signing secret in `shouldertap-dev`, and run the scenarios below. The new server code is not deployed; merchant acceptance of this optional-support model, real checkout/portal behavior and deployed integration remain unverified. Existing legacy product IDs and webhook secrets were retained.

1. Obtain/confirm Creem merchant approval for this optional annual support model. Matching sandbox/live products already exist as recorded above: active, fixed USD 2400, recurring `every-year`, no trial, no metered prices, no add-ons or feature licenses, exclusive tax. The dashboard return URL was left unset; checkout creation supplies its return URL. Verify that destination after deployment; redirects confer no membership. Keep the old one-time product ID for historical webhook handling; retire its public purchase links during the free-core rollout without deleting purchase history.
2. `CREEM_PATRON_PRODUCT_ID` is set in each matching Infisical project. Retain `CREEM_PRODUCT_ID` for the old product, `CREEM_API_KEY` and the existing production `CREEM_WEBHOOK_SECRET`; sandbox still needs its own signing secret. Keys, product and webhook must all use the same mode. Test keys select Creem sandbox. Use Alchemy/Infisical only; PR previews remain credential-free. No production values belong in dev.
3. The live HTTPS API `/v1/webhooks/creem` endpoint now subscribes to `checkout.completed`, `subscription.paid`, `subscription.active`, `subscription.scheduled_cancel`, `subscription.canceled`, `subscription.past_due`, `subscription.unpaid`, `subscription.expired`, `subscription.paused` and `refund.created`. Register the sandbox counterpart against the actual deployed development/test URL. Verify metadata reaches the subscription and that hosted portal cancellation/payment recovery works.
4. Before live checkout enablement, run sandbox checkout, duplicate delivery, delayed renewal/cancellation/refund, portal cancellation and refund scenarios against a deployed test stack. Local SDK tests fake only HTTP and SQLite tests fake only Cloudflare storage; provider sandbox tests have not yet run.
5. Ship the free-core server before clients/marketing that advertise free use. Do not roll back to a server that enforces the old trial gate. Keep historical data and the free-core compatibility patch during any billing rollback.

## iPhone purchase boundary and review

Current Apple guidelines 3.1.1(a)/3.1.3 restrict external purchase calls to action outside permitted storefronts. Native checkout/management controls therefore use **StoreKit's current USA storefront**, watched for updates and rechecked on action; nil/non-US hides the controls. Locale, language and IP do not grant eligibility. Other storefronts show free use and server-provided patron status only. Existing frame Help sheets keep `.sheetOnPaper()`. No StoreKit IAP product or external-link entitlement was created. No benefits depend on payment in any storefront.

App Review remains an external gate: explain the optional recurring support, free functionality, USA-only links, absence of in-app benefits/rewards, annual billing and server-first rollout in review notes. Verify real storefront changes, US checkout/portal return, non-US absence of purchase controls, and physical-device pairing/send/reply before submission. The simulator does not prove a US storefront or live billing. Swift 6 Shape-isolation build fixes are included at the code layer (`IconShape`, `MarkFrame`, `Knock` are explicitly nonisolated geometry).

## Sources checked

- [Creem webhooks](https://docs.creem.io/code/webhooks)
- [Creem customer portal](https://docs.creem.io/features/customer-portal)
- [Creem TypeScript SDK](https://docs.creem.io/code/sdks/typescript)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
