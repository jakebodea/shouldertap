# Free core and optional patrons

Implementation as of October 21, 2026. This document describes code and local verification, not an enabled or live payment product.

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

Nothing here created a provider product, changed secrets or charged a card.

1. Obtain/confirm Creem merchant approval for this optional annual support model. Create separate sandbox/live products: active, fixed USD 2400, recurring `every-year`, no trial, no metered prices, no add-ons or feature licenses. Use exclusive tax if charging applicable tax in addition. Set a neutral success destination such as `https://shouldertap.app/support`; redirects confer no membership. Keep the old one-time product ID for historical webhook handling; retire its public purchase links without deleting purchase history.
2. In the appropriate Infisical `shouldertap-dev`/`shouldertap-prod` project set `CREEM_PATRON_PRODUCT_ID`, retaining `CREEM_PRODUCT_ID` for the old product, `CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET`. Keys, product and webhook must all use the same mode. Test keys select Creem sandbox. Use Alchemy/Infisical only; PR previews remain credential-free. No production values belong in dev.
3. Register the HTTPS API `/v1/webhooks/creem` endpoint and enable `checkout.completed`, `subscription.paid`, `subscription.active`, `subscription.scheduled_cancel`, `subscription.canceled`, `subscription.past_due`, `subscription.unpaid`, `subscription.expired`, `subscription.paused` and `refund.created`. Verify metadata reaches the subscription and that hosted portal cancellation/payment recovery works.
4. Before live enablement, run sandbox checkout, duplicate delivery, delayed renewal/cancellation/refund, portal cancellation and refund scenarios against a deployed test stack. No sandbox credentials were supplied to this run or used here; local SDK tests fake only HTTP and SQLite tests fake only Cloudflare storage.
5. Ship the free-core server before clients/marketing that advertise free use. Do not roll back to a server that enforces the old trial gate. Keep historical data and the free-core compatibility patch during any billing rollback.

## iPhone purchase boundary and review

Current Apple guidelines 3.1.1(a)/3.1.3 restrict external purchase calls to action outside permitted storefronts. Native checkout/management controls therefore use **StoreKit's current USA storefront**, watched for updates and rechecked on action; nil/non-US hides the controls. Locale, language and IP do not grant eligibility. Other storefronts show free use and server-provided patron status only. Existing frame Help sheets keep `.sheetOnPaper()`. No StoreKit IAP product or external-link entitlement was created. No benefits depend on payment in any storefront.

App Review remains an external gate: explain the optional recurring support, free functionality, USA-only links, absence of in-app benefits/rewards, annual billing and server-first rollout in review notes. Verify real storefront changes, US checkout/portal return, non-US absence of purchase controls, and physical-device pairing/send/reply before submission. The simulator does not prove a US storefront or live billing. Swift 6 Shape-isolation build fixes are included at the code layer (`IconShape`, `MarkFrame`, `Knock` are explicitly nonisolated geometry).

## Sources checked

- [Creem webhooks](https://docs.creem.io/code/webhooks)
- [Creem customer portal](https://docs.creem.io/features/customer-portal)
- [Creem TypeScript SDK](https://docs.creem.io/code/sdks/typescript)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
