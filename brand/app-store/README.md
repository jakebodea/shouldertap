# App Store and screen-experience artwork

Revised October 21, 2026 (v3). Draft for review; nothing uploaded or published.

## Deliverables

`exports/` contains seven App Store compositions, each at 1206 × 2622 and 1320 × 2868, plus `marketing-screen-story-1920x1080.png` for web/social use. `index.html` is the review gallery; `manifest.json` lists the current outputs. Review the individual images inline; the original `output/shouldertap-screen-marketing-v3.zip` is retained as historical artwork and is not refreshed by the renderer.

1. **A tap that’s hard to miss** — the native iPhone full-screen receiving view, on Sky so Maya's Moss frame pops. Her own quick replies ("Coming!", "Save me a plate") are the buttons. The mark's three knock marks land on the phone's shoulder.
2. **A familiar face. In your Island** — the compact Dynamic Island, enlarged, then "Press and hold" into the expanded island with native answer buttons. The phone bleeds off the bottom; the home screen below is not the story.
3. **Right on your Lock Screen** — the actual Live Activity card, enlarged over the phone where it sits.
4. **One tap. Every linked screen** — a Mac display and a Windows laptop, each showing its native overlay, plus the linked iPhone.
5. **Get an answer. Carry on** — native sender with a typed reply; the reply card is enlarged.
6. **Only people you invite** — the iPhone Add People screen with its invite link and QR code.
7. **A browser. A little tap** — the actual browser sender, then the iPhone receiving view.

The shared `devices.mjs` renderer supplies phone hardware (6.3" Pro proportions: screen corners, island size, side keys), display/laptop surrounds, browser chrome and `loupe()`. Phone captures always go through its `phone()` wrapper. Dynamic Island captures retain the system-rendered island; other captures get the hardware island cutout. Enlarged details ("loupes") are CSS crops of the same capture pixels at about 1.0–1.3× capture resolution; no UI is redrawn. Capture regions are named in `render.mjs` (`regions`). The browser window shows the whole 700 × 900 capture, taken at that window width so the page lays itself out as it would there. Original captures remain in `captures/`.

Slides carry no header notes or footers, so devices can bleed off the bottom.

The widescreen image tells the cross-device story. It is marketing artwork, not an App Store screenshot size.

### Known capture issue

Each Mac overlay pill shows thin vertical slivers at its left and right edges (visible at full size of `captures/mac-overlay.png`). They reproduce with both `cacheDisplay` and `CALayer.render`, so they come from the `OverlayView` tree, not the capture method, and may also appear in the shipping overlay. They are barely visible at composition sizes; fix in the app (not the artwork) and recapture.

## What is real and what is composited

- iPhone: actual SwiftUI app and WidgetKit views, captured on shared `agent-sim-1` (iPhone 18 Pro, iOS 27), using fictional people from `messages.mjs` (Maya, Marcus, Theo and Rosa tapping Nina) and a local fixture service. The Live Activity is created through ActivityKit by an explicit simulator-only Debug launch flag. It uses the same `TapActivityAttributes` and widget extension as the app. This is visual evidence, not APNs delivery proof.
- Dynamic Island: use `xcrun simctl io <udid> screenshot --mask=black ...`. The default unmasked screenshot omits this system layer. Both compact and expanded views were inspected. The Lock Screen layout was captured through Notification Center's cover sheet.
- Mac: `capture-mac.sh` compiles the existing native `OverlayView`, Theme, Icons and Core into a temporary harness, registers the app fonts and captures an offscreen `NSHostingView`. It does not launch the user's installed Mac app or cover their real displays.
- Web: `capture-web.mjs` renders the real `/tap` route against fictional local state. Its browser boundary supplies CORS and the API's expected POST status for the fixture.
- Device bodies, desktop browser toolbar, knock marks and loupe shadows are authored presentation. The Mac and PC overlays are separate native renders of the same tap; together with the iPhone they illustrate that a tap reaches every linked screen, not a live multi-device delivery test.

Source checkout: `e991275`, plus the simulator-only capture trigger in this worktree. The approved distribution binary has not been compared with this checkout. App Store Connect required login in this session. Compare against the approved build and confirm the editable version/slots before upload. Historical `docs/app-store/readiness.md` does not establish current listing state.

## Regenerate images

```sh
bun install --frozen-lockfile
node brand/app-store/render.mjs
```

Uses the installed Chrome through Playwright and the repo's Bricolage font. The script replaces only generated PNGs under `exports/`; preserve anything hand-authored elsewhere.

## Recreate native captures

Use an available shared simulator per AGENTS.md; never create one, and shut down only the one you boot.

1. Run `bun brand/app-store/fixture-server.mjs` (localhost:4318 only).
2. Build `ShouldertapIOS` with the normal Swift 6 settings. The original v3 captures used a Swift 5 override before the geometry isolation fixes; current source builds with Swift 6.
3. Install and launch with `SIMCTL_CHILD_SHOULDERTAP_SERVER_URL=http://127.0.0.1:4318`.
4. Get started → sign in with any email and any six-digit code, then turn on notifications. The fixture's account sync makes the phone Nina's inbox and gives it one sender's key to tap Nina, so it shows both sides; start the fixture with `SHOULDERTAP_FIXTURE_SENDER=<messages.mjs key>` to choose whose (e.g. `dinner` for Maya's composer, `call` for Theo's reply). Incoming taps take their sender and quick replies from their body. The 9:41 status bar on app captures is `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charging --batteryLevel 100`; clear it before system captures.
5. Set the plain wallpaper: `xcrun simctl addmedia <udid> brand/app-store/wallpaper.png`, then Photos → Share → Use as Wallpaper for both Lock and Home Screen. Remove the photo after capturing.
6. POST `/v1/taps` with `{"requestId":"marketing-tap-01","body":"Dinner's ready"}` (bodies are in `messages.mjs`; each capture is named for the message it shows, e.g. `iphone-takeover-dinner.png`). The foreground receiving view covers the app.
7. For the system surfaces, relaunch with `SIMCTL_CHILD_SHOULDERTAP_CAPTURE_ACTIVITY=1` and `SIMCTL_CHILD_SHOULDERTAP_CAPTURE_BODY=<message>`, `..._CAPTURE_SENDER`, `..._CAPTURE_COLOR` and optional `..._CAPTURE_REPLIES="a|b"`. This explicitly starts a local activity for that same fictional tap. Allow Live Activities in the system prompt. The flag and helper are compiled out outside simulator Debug builds.
8. Home shows compact Dynamic Island; press and hold it for expanded. Open Notification Center for the Lock Screen card. Use `--mask=black` for system captures. Avoid normalized status-bar overrides for these captures.
9. POST `/capture/display` or `/capture/reply` (optional `{"text": ...}`) for sender states. After capture, answer the fixture tap and foreground the app to reconcile/end the activity; then shut down your simulator.

Mac: `bash brand/app-store/capture-mac.sh`.

PC: `bash brand/app-store/capture-pc.sh`. It renders the real Windows overlay (`apps/windows`, GPUI) on this Mac through the dev build's snapshot mode: one 1440 × 900 window opens on screen for about four seconds, `screencapture` takes only that window (found by `window-id.swift`), and the app quits. The terminal running it needs Screen Recording permission.

Web: run `VITE_SERVER_URL=http://127.0.0.1:4318 bun run --cwd apps/web dev:bare --host 127.0.0.1 --port 4319`, then `node brand/app-store/capture-web.mjs` while the fixture has a tap.

## Requirements and existing assets

The current target is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`). Apple accepts 1–10 screenshots per required device size, PNG/JPEG without alpha. Current specifications name the medium Dynamic Island display as required: export 1206 × 2622, plus 1320 × 2868 for the large display. No iPad artwork is required for this target.

The app's `Assets.xcassets/AppIcon.appiconset/icon-1024.png` is already 1024 × 1024 without alpha; the iOS listing icon comes from the uploaded build. The 512px social icon is not a replacement.

Existing `brand/og`, `square`, `x`, `linkedin`, `github`, `wide`, and `logo` assets remain available. Add an official App Store badge/link after verifying the public listing.

Sources checked October 21, 2026:

- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- https://developer.apple.com/help/app-store-connect/manage-app-information/add-an-app-icon/
- https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications

The regenerated compositions describe the integrated free-core, phone-first source. Their underlying fictional captures predate that integration; recapture and compare against the distribution binary before upload. Optional Patron support is $24/year and never unlocks core messaging. No themes or permanent cosmetics are promised by these images.
