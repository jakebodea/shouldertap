# 0.2.0 open candidate

The public 0.1.0 app is separate from this unsubmitted candidate. Version 0.2.0 remains open for themes and further changes; do not submit App Review or publicly release it yet. No production deployment or TestFlight upload has been performed by this preparation run.

## Source and identity

`apps/ios/Version.xcconfig` is shared by app/widget Debug and Release: 0.2.0, provisional build 2 pending current App Store Connect build inventory. Release bundle IDs are `app.shouldertap.iphone` and `app.shouldertap.iphone.widgets`, matching the public app. Preserve the `app.shouldertap.iphone.inbox` Keychain service so existing recipients keep their owner credential. The historical `app.shouldertap.ios` record is not this release target.

The release script requires a positive build integer, refuses upload from dirty source, checks the archived canonical app identity, and embeds `ShouldertapSourceRevision`. CI reads the actual archived build number. Never use a successful archive or upload as evidence of processed TestFlight availability.

## Compatibility and rollout

Free-core server changes must deploy before clients or marketing advertise free access. Additive migrations preserve old trials/purchases. Old clients get `plan.status=paid` only for compatibility. The new iPhone records `platform=iphone`; it can create an inbox without a computer, and computers may be removed while phones remain.

New patron checkout is fail-closed: `PATRON_CHECKOUT_ENABLED` defaults false, before product lookup/reservation/provider creation. Resolve merchant/optional-support rollout requirements before enabling it. Existing customer management and signed webhooks remain available. No iPhone external checkout controls are included. Theme/paid-cosmetic behavior is not part of this candidate yet.

`GET /version` reports the Cloudflare version ID, revision tag, free-core state and patron-signup gate with no-store caching. CI tags server uploads with COMMIT_SHA; manual Alchemy deploys must set that exact public revision too. Verify the live revision independently after deployment.

## Recovery boundary

No email/password/account recovery exists. The secure existing path is a one-time device link from any still-authorized receiver. Same-device upgrades retain Keychain credentials; sender invitations cannot restore ownership. Setup and self-unlink confirmation disclose the loss-of-last-device risk.

Before replacing/resetting the last receiver, link another trusted device and verify it can open the inbox. Total loss requires either starting a new inbox and reinviting senders, or a future deliberately designed recovery-key feature. Do not recover an inbox from a claimed name/email, weaken bearer authentication, or add an unreviewed account service. Product decision remains whether to ship this explicit invite-only recovery boundary or add an offline recovery key before the final release.

## Physical-device and signing state

Read-only device discovery found one paired available physical iPhone Air. A browser/simulator sender to that real iPhone can exercise APNs; two-physical-phone coverage needs another phone. No personal-device app was installed or replaced in this run.

Local Debug device build is blocked by no signed-in Xcode account and absent development profiles for the separate debug app/widget IDs. Release archive succeeds for the canonical app, but export is blocked: cached App Store profiles name a distribution certificate whose private key is not installed, and automatic profile repair has no authenticated account. Existing distribution identity alone is insufficient. Use the supported authenticated signing workflow; do not substitute the old app record or claim an unsigned archive is installable.

## Required verification before a release decision

- Recheck the current ASC build inventory; select a unique sequential build number.
- Review the combined implementation and any incoming theme changes, run all local/hosted checks, and retain exact source revision.
- Finish authenticated signing and physical-device invite/send, foreground answer, notification fallback, push-to-start, background answer, relaunch and cross-device dismissal. Permission/Focus conditions matter; iOS does not cover other apps.
- Make the recovery product decision above. Confirm public-app upgrade keeps owner access.
- Perform authorized server-first rollout with signup disabled; verify exact live revision, old-client compatibility and free phone-only send/reply.
- Upload only the reviewed candidate, wait for VALID processing, assign/check the intended internal TestFlight group, then test that binary. Keep App Review/public release pending until explicitly authorized.

The marketing renderer preserves the latest requested minimal artwork: no free/Mac-optional capability headers or explanatory footers. Existing captures predate this candidate; compare/recapture against the eventual distribution build. Listing copy is a draft, and the public 0.1.0 listing remains unchanged.
