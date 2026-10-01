# Shouldertap

A trusted person can send a message that appears across your connected computer displays until you acknowledge it, then receive your response.

[Shouldertap: app idea](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) is the source of truth for the concept. [Architecture plan](docs/architecture.md), [design system](docs/design.md), [Apple client research](docs/research/apple-clients.md), [backend research](docs/research/backend-stack.md).

## What v0 does

1. **Pair**: the Mac app creates your inbox on first launch. "Create invite link" shows a QR code and link for a sender's phone; "Add another Mac" gives a one-time code for your other Macs.
2. **Send**: the sender opens the link in Safari, enters their name, picks a color, and sends a tap. Unpaired visitors to the site see the landing page.
3. **Pause**: every paired Mac covers every display with the message, above full-screen apps and on every Space.
4. **Respond**: On it, In 10 min, or a typed reply. The overlay is framed in the sender's color. Answering on one Mac dismisses it on all of them.
5. **Close the loop**: the sender sees delivered → on screen → the reply, live.

## Layout

Alchemy is the source of truth for infrastructure and backend structure: one Stack at the workspace root composes everything.

```text
alchemy.run.ts          Composition root: Server Worker + Safari sender site
apps/server/src/Server.ts   Cloudflare.Worker: Effect HttpApi + WebSocket forwarding
apps/server/src/Inbox.ts    Cloudflare.DurableObject: one per recipient, Drizzle over its SQLite
apps/server/src/TrialLedger.ts  Cloudflare.DurableObject: one per Mac fingerprint, remembers when its free trial ends
apps/server/src/schema.ts   Drizzle schema; migrations in apps/server/drizzle (drizzle-kit, durable-sqlite)
apps/server/test/           Alchemy Test harness: deploys the Stack, drives the protocol
apps/web                    Safari sender (React, TanStack Router, Vite) via Cloudflare.Website.Vite
apps/macos                  Native Swift menu-bar app (AppKit + SwiftUI), a Swift package
apps/ios                    Native iOS sender (SwiftUI), an Xcode project linking ShouldertapCore from apps/macos
packages/domain             Effect Schema contracts, typed errors, the HttpApi spec
packages/client             HttpApiClient-based client + live WebSocket (tickets, reconnect, resync)
```

`apps/macos` is outside the Bun workspace. `ShouldertapCore` mirrors `packages/domain` and `packages/client` in Swift (contracts, API client, live socket, store); its tests decode fixtures in the server's JSON shapes. Change the protocol in both places. [Mac client research](docs/research/mac-client-efficiency.md) explains the move from React Native.

## Develop

```bash
bun install
```

```bash
bun run dev            # alchemy dev: API on :3000, web on :3001, Workers and DOs in local workerd
```

```bash
cd apps/server && bun run test:local     # integration suite against a local Stack
```

```bash
cd apps/server && bun run test           # same suite, deployed to the test_$USER stage and destroyed after
```

Schema changes: edit `apps/server/src/schema.ts`, then generate and commit a migration. Each Inbox applies pending migrations when it activates.

```bash
cd apps/server && bun run db:generate
```

Mac app (needs Xcode; `DEVELOPER_DIR` avoids `sudo xcode-select`). Tests, then a debug build that talks to the local stack:

```bash
cd apps/macos && swift test
```

```bash
cd apps/macos && open "$(scripts/build.sh)"
```

Debug builds talk to `localhost` (override with `SHOULDERTAP_SERVER_URL` and `SHOULDERTAP_WEB_URL`) and run as a separate app, "Shouldertap Debug" (`app.shouldertap.mac.debug`), with their own pairing in `~/Library/Application Support/Shouldertap Debug`. Release builds use production (`apps/macos/Sources/Shouldertap/App.swift`, `Config`).

iOS sender. It links `ShouldertapCore` from `apps/macos` as a local package, so `swift test` there covers its sender logic too. Build, install and launch on the booted simulator:

```bash
cd apps/ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project Shouldertap.xcodeproj -scheme ShouldertapIOS -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build build
```

```bash
xcrun simctl install booted apps/ios/build/Build/Products/Debug-iphonesimulator/Shouldertap.app && xcrun simctl launch booted app.shouldertap.ios.debug
```

Debug builds talk to `http://localhost:3000` (override with `SHOULDERTAP_SERVER_URL`). Open an invite with `xcrun simctl openurl booted 'shouldertap://join#<code>'`, or paste the link. The UI test pairs and sends a tap end to end when given an invite (skipped otherwise): `TEST_RUNNER_SHOULDERTAP_INVITE='shouldertap://join#<code>' xcodebuild test …` with the same project, scheme and destination.

## Deploy

Production is the `prod` stage: the site at `https://shouldertap.app` (`www` redirects), the API at `https://api.shouldertap.app`, and Mac downloads at `https://download.shouldertap.app`. Hostnames live in `domains.ts`; other stages stay on `workers.dev`. The domain is registered with Cloudflare Registrar on the same account (auto-renew off, renews 2027-09-30).

GitHub Actions (`.github/workflows/deploy.yml`) lints and type-checks every push and PR, deploys `main` to `prod`, and deploys each PR to a `pr-<number>` preview, runs the integration tests against it, comments the links on the PR, and destroys it when the PR closes. Its Cloudflare token is minted by `stacks/github.ts` and stored as repo secrets; deploy that under the `admin` profile once, and again to rotate or rescope the token:

```bash
bun alchemy deploy --config stacks/github.ts --profile admin
```

App secrets (`SUPPORT_FORWARD_TO`, a comma-separated list of addresses `support@` forwards to; payment and analytics keys to come) live in the Infisical project `shouldertap` (`.infisical.json`). CI loads the `prod` environment through the `INFISICAL_IDENTITY_ID` machine identity, which trusts GitHub OIDC tokens from `main` only.

To deploy by hand, with prod's secrets injected:

```bash
infisical run --env prod -- bun run plan -- --stage prod
```

```bash
infisical run --env prod -- bun run deploy -- --stage prod --yes
```

`dev` is a scratch stage: web `https://shouldertap-web-dev-np4ztb2ul2oajd6h.jakebodea.workers.dev`, API `https://shouldertap-server-dev-rtv4iyushaacenl3.jakebodea.workers.dev`.

## Release the iOS app

Archive, sign for App Store distribution (team `6C46GY4Z38`, automatic signing through the Apple ID in Xcode or an App Store Connect API key; see the script header) and upload to App Store Connect, where the build shows up in TestFlight after processing:

```bash
scripts/release-ios.sh
```

Or label a pull request `release:beta`: when it merges, `.github/workflows/testflight.yml` runs the same script on a macOS runner from the merged `main` and comments the build number on the PR. Actions > TestFlight > Run workflow releases `main` on demand. CI signs with an App Store Connect API key (Admin role, so it can create the distribution certificate) from Infisical `prod`: `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (the `.p8` file's contents).

The version is `MARKETING_VERSION` in the Xcode project; bump it for a new version. The build number is the commit count (`git rev-list --count HEAD`), so it rises with every commit on `main` and needs no bumping; set `BUILD_NUMBER` to override. Releasing the same commit twice fails, since App Store Connect rejects a repeated build number. `--no-upload` exports the `.ipa` only. Release builds talk to production. The app declares `ITSAppUsesNonExemptEncryption = NO` (HTTPS only), so uploads skip the export compliance question.

## Release the Mac app

Bump `CFBundleShortVersionString` and `CFBundleVersion` in `apps/macos/Resources/Info.plist`, then test and build a universal DMG and upload it to the `shouldertap-releases` R2 bucket (needs `wrangler login`):

```bash
scripts/release-mac.sh
```

It uploads `Shouldertap-<version>.dmg` (immutable), overwrites `Shouldertap.dmg` (the site's Download button), then publishes `appcast.xml`, the [Sparkle](https://sparkle-project.org) feed installed apps check daily. `--no-upload` builds only. `CFBundleVersion` must go up every release; Sparkle compares it.

Updates are signed with an EdDSA key in the login keychain (account `app.shouldertap.mac`); its public half is `SUPublicEDKey` in Info.plist. Without the private key no update can ship to existing installs, so keep a copy somewhere safe, such as a password manager:

```bash
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account app.shouldertap.mac -x shouldertap-sparkle-key.txt
```

Debug builds can rehearse an update against a local feed with `SHOULDERTAP_FEED_URL` and `SHOULDERTAP_UPDATE_SELFTEST=1`, which downloads, installs and relaunches without UI.

Builds are ad-hoc signed until there's an Apple Developer ID, so Gatekeeper makes people click Open Anyway on first launch (the download page explains it). With a Developer ID, set `SIGN_IDENTITY` and `NOTARY_PROFILE` (see the script header) and drop the "Allow it once" step from `apps/web/src/routes/download.tsx`.

## Known gaps in v0

- No accounts: trust is invite links plus revocable bearer credentials. Anyone can create a new (empty) inbox, rate-limited to 10 per client IP per minute (Cloudflare's approximate, per-location limiter). Running the integration suite uses up that budget for a minute.
- The Mac credential lives in an owner-only file in `~/Library/Application Support/Shouldertap`, not the Keychain, because builds are ad-hoc signed (no Developer ID), so the Keychain would prompt after every rebuild.
- The overlay can't be dismissed without answering. If the Mac is offline, answering still dismisses locally and the reply is retried until the server accepts it.
- Handled in code but not yet tested by hand: Durable Object hibernation, sleep/wake, display hot-plug, full-screen apps/Spaces, and replying while offline. Tested: overlays on two displays, replying from the overlay, cross-Mac dismissal, and the protocol via the Alchemy integration suite.
- Sender history is capped at 50 recent taps.
- One free trial per Mac: at "Get started" the Mac app sends `machine`, a salted SHA-256 of its hardware UUID (Debug builds use a different salt). The Server asks that Mac's `TrialLedger` for its trial end (recorded on first setup) and starts the new inbox with it, so unpairing and setting up again resumes the same trial. Mac apps older than this don't send `machine` and still get a fresh trial per setup. If the ledger can't answer, setup falls back to a fresh trial rather than failing.
- Limits, enforced by the Inbox: 30 taps per sender per rolling hour (`TooManyRequests`, 429; retries of an existing request id still succeed), and 20 active senders and 10 active Macs per inbox (`Conflict`, 409, from `createInvite` and `redeemInvite`).
- Retention: a daily Durable Object alarm (Alchemy's `scheduleEvent`, armed at inbox creation and on any activation) deletes taps older than 90 days, invites a day after they expire, expired connect tickets, and removed pairings 90 days after removal once none of their taps remain. See `apps/server/src/retention.ts`. On the Workers Free plan each alarm run counts toward the 100,000 Durable Object requests per day, so that's one request per inbox per day.
