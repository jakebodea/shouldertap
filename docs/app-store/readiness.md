# iPhone 1.0 submission

Updated October 5, 2026. App Store Connect app ID: `6818330440`.

## Configuration

- iPhone device family only, iOS 17 minimum, version 1.0.
- Free iPhone sender and linked-inbox companion; U.S. availability only; manual release after approval.
- App Store screenshots must be actual app screens with fictional names/messages.
- Metadata: `en-US.json`. Reviewer instructions: `review-notes.txt`.
- Private review contact details stay in App Store Connect, not this repository.

## Privacy answers

Collected for app functionality, linked to the sender pairing, not used for tracking:

- Name: sender/recipient display names and linked device names used in an inbox.
- Emails or Text Messages: sent and received tap text, replies and message metadata.
- User ID: persistent sender pairing, inbox and linked-device credential IDs.
- Device ID: APNs device and Live Activity delivery tokens linked to the inbox device credential. App Store privacy answers must include this category, linked to identity, for App Functionality only; no tracking.
- Email Address and Customer Support: reports voluntarily sent to support using the mail/share flow.
- Other Diagnostic Data: standard server/provider request logs for reliability and debugging.

Provider request logs are included as Other Diagnostic Data; the privacy policy describes IP address and request metadata used for reliability and debugging. The Mac's trial fingerprint and purchase email are collected by the separate Mac/web recipient flow; do not automatically classify them as iPhone collection. Privacy manifest and App Store privacy answers are separate requirements.

## Current resubmission

Apple rejected 1.0 (49) on October 2 under Guideline 2.1, Information Needed, citing limited developer-account review history. No specific crash or payment defect was identified. The existing 1.1 source is now the first public 1.0: sending plus linked-inbox receiving, Live Activities/notifications and inbox management. All app/widget version settings use 1.0. The old 1.1 beta is to be expired after a replacement 1.0 is available; Apple retains the upload record.

`review-notes.txt` covers Apple's requested purpose/audience, setup, external services, regions and rights, with an explicit pending-recording statement. `review-reply-draft.txt` is an unsent template, not an assertion that a new video exists. Refresh its recording statement only after the new physical-device evidence is attached.

## Remaining release gates

- Test the exact replacement TestFlight build on a physical iPhone running the latest public OS. Verify Help in light/dark mode, QR scanning/camera denial and paste fallback, live send/delivery/reply, link/receive/answer, Live Activity and notification fallback, reporting/blocking and deletion of a disposable sender pairing only.
- Make a fresh physical-device recording starting at launch and showing those flows. Use a second paired sender/device to trigger incoming taps. Do not substitute a simulator recording or the local sample. See `recording-checklist.md`.
- Attach the new recording in App Review Information and the rejection reply; put all six answers in both Review Notes and the reply. Remove the pending-recording text only when evidence exists. Do not submit yet.
- Recheck App Store privacy answers for Device ID (APNs/Live Activity tokens), received messages and linked inbox credentials. These are linked to identity for App Functionality only, with no tracking. The binary privacy manifest now includes Device ID. The public privacy policy already describes linked-iPhone push tokens.
- Refresh screenshots to the current UI and include the Inbox/receiving flow; current sender screenshots predate the two-tab interface.
- App Store availability remains U.S. only; manual release, free pricing and existing age/content-rights declarations must be retained.
- Review setup uses a fresh Mac inbox and generated invites/link codes. Offer assisted access if needed. The public Mac download is Developer ID signed and notarized; a sample is explanatory only.
- Backend deletion/filter and push delivery are existing functionality; real-device delivery must be checked for the new distribution build before resubmission.

## Sources checked

- [Review guidelines](https://developer.apple.com/app-store/review/guidelines/): completeness, private messaging safety, privacy/deletion and free companion rules.
- [Privacy details](https://developer.apple.com/app-store/app-privacy-details/): non-SMS messages count as Emails or Text Messages; IDs can link data to a user.
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
- [Submission steps](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app): Add for Review prepares a draft; Submit for Review sends it.

## Validation before upload

- Shared Swift tests: 50 passed. Server unit tests: 18 passed. Server integration tests: 9 passed, including deletion isolation and content rejection.
- Native UI tests passed for help/sample flow and a real local pairing, send, delivery and reply flow. The Help regression additionally measures rendered text contrast in light and dark appearance after a green pairing, including Privacy Policy, Done, Report and the sample; see `validation/` for before/after evidence. Screenshots are 1320 × 2868 from iPhone 17 Pro Max (iOS 26.3), with fictional people and messages.
- Type checking and lint passed. PR CI additionally runs the Mac download flow and deployed-preview integration tests.
