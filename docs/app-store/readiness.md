# iPhone 1.0 submission

Prepared October 2, 2026. App Store Connect app ID: `6818330440`.

## Configuration

- iPhone device family only, iOS 17 minimum, version 1.0.
- Free iPhone sender companion; U.S. availability only; manual release after approval.
- App Store screenshots must be actual app screens with fictional names/messages.
- Metadata: `en-US.json`. Reviewer instructions: `review-notes.txt`.
- Private review contact details stay in App Store Connect, not this repository.

## Privacy answers

Collected for app functionality, linked to the sender pairing, not used for tracking:

- Name: the display name chosen during pairing.
- Emails or Text Messages: tap text, recipient replies and message metadata.
- User ID: persistent sender pairing/credential ID.
- Email Address and Customer Support: reports voluntarily sent to support using the mail/share flow.
- Other Diagnostic Data: standard server/provider request logs for reliability and debugging.

Provider request logs are included as Other Diagnostic Data; the privacy policy describes IP address and request metadata used for reliability and debugging. The Mac's trial fingerprint and purchase email are collected by the separate Mac/web recipient flow; do not automatically classify them as iPhone collection. Privacy manifest and App Store privacy answers are separate requirements.

## Remaining release gates

- Builds from PR #35 on add the inbox companion (a linked iPhone manages the recipient's inbox: senders' names and colors, device names, and received taps with their answers) and a Live Activity widget extension that release builds never start. Before submitting one of those builds, update the reviewer notes (how to link, with a test Mac code) and recheck the privacy answers, which describe a sender-only app.
- Version 1.0 is available to the existing internal “Me” TestFlight group. Physical testing of build 47 found inherited cream text on the Help sheet when using a green frame. Use the replacement containing the explicit system text-color fix for the final device check.
- Backend deletion endpoint/filter deployed from PR #31; support/privacy wording corrected in PR #32.
- Test the actual TestFlight build on a physical iPhone, including camera permission denial and QR scanning.
- Age-rating questionnaire saved: private messaging and user-generated content present; no public social feed.
- Free pricing and U.S.-only availability saved; Mac App Store and Vision Pro distribution disabled. Privacy declaration published with developer confirmation. Content-rights answer saved as no third-party content, as confirmed by the developer. Apple agreements remain developer-owned; EU trader verification is outside this U.S. launch.
- Reviewer setup uses the public Mac companion and a fresh inbox, with no pre-issued invite/password. Confirm they have a Mac available; offer assisted access if requested. The public sample is an explanation, not evidence a real Mac received a message.
- Mac download checked October 2: Developer ID signature accepted by Gatekeeper; downloaded DMG's stapled notarization validated. Older README/support claims of ad-hoc signing were stale.
- User's final TestFlight verification precedes Submit for Review.

## Sources checked

- [Review guidelines](https://developer.apple.com/app-store/review/guidelines/): completeness, private messaging safety, privacy/deletion and free companion rules.
- [Privacy details](https://developer.apple.com/app-store/app-privacy-details/): non-SMS messages count as Emails or Text Messages; IDs can link data to a user.
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
- [Submission steps](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app): Add for Review prepares a draft; Submit for Review sends it.

## Validation before upload

- Shared Swift tests: 50 passed. Server unit tests: 18 passed. Server integration tests: 9 passed, including deletion isolation and content rejection.
- Native UI tests passed for help/sample flow and a real local pairing, send, delivery and reply flow. The Help regression additionally measures rendered text contrast in light and dark appearance after a green pairing, including Privacy Policy, Done, Report and the sample; see `validation/` for before/after evidence. Screenshots are 1320 × 2868 from iPhone 17 Pro Max (iOS 26.3), with fictional people and messages.
- Type checking and lint passed. PR CI additionally runs the Mac download flow and deployed-preview integration tests.
