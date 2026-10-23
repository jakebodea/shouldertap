# Shouldertap

A trusted person can send a message to your iPhone or connected computer displays, then receive your response. Core messaging is free; a Mac is optional for screen takeover.

[Shouldertap: app idea](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) is the source of truth for the concept. [Architecture plan](docs/architecture.md), [design system](docs/design.md), [Apple client research](docs/research/apple-clients.md), [backend research](docs/research/backend-stack.md).

## What v0 does

1. **Pair**: create your inbox on iPhone or Mac, then invite someone. "Create invite link" shows a QR code and link for a sender's phone; "Add a Mac or iPhone" gives a one-time code for your other Macs, and a QR code that links your iPhone to manage the inbox (invite and remove people, see devices and recent taps).
2. **Send**: the sender opens the link in Safari, or pastes it into Shouldertap on their iPhone, Mac or PC ("You can tap" in the menu), enters their name, picks a color, and sends a tap. A computer can send without receiving, like an iPhone. Unpaired visitors to the site see the landing page.
3. **Receive**: iPhone shows a takeover while the app is open, or notifications/Live Activities in the background subject to iOS permissions. A paired Mac covers every display, above full-screen apps and on every Space.
4. **Respond**: On it, In 10 min, or a typed reply. The overlay is framed in the sender's color. Answering on any device dismisses it on the others.
5. **Close the loop**: the sender sees delivered → on screen → the reply, live.

## Layout

Alchemy is the source of truth for infrastructure and backend structure: one Stack at the workspace root composes everything.

```text
alchemy.run.ts          Composition root: Server Worker + Safari sender site
apps/server/src/Server.ts   Cloudflare.Worker: Effect HttpApi + WebSocket forwarding
apps/server/src/Inbox.ts    Cloudflare.DurableObject: one per recipient, Drizzle over its SQLite
apps/server/src/SenderPatron.ts Cloudflare.DurableObject: one per sender patron identity (keys, billing facts), its own SQLite in apps/server/drizzle-patron
apps/server/src/TrialLedger.ts  Cloudflare.DurableObject: historical trial records, retained but no longer consulted
apps/server/src/schema.ts   Drizzle schema; migrations in apps/server/drizzle (drizzle-kit, durable-sqlite)
apps/server/test/           Alchemy Test harness: deploys the Stack, drives the protocol
apps/web                    Safari sender (React, TanStack Router, Vite) via Cloudflare.Website.Vite
apps/macos                  Native Swift menu-bar app (AppKit + SwiftUI), a Swift package
apps/ios                    Native iOS sender (SwiftUI), an Xcode project linking ShouldertapCore from apps/macos
apps/windows                Native Windows tray app (Rust + GPUI), a Cargo workspace: core/ (protocol, no UI) and app/
packages/domain             Effect Schema contracts, typed errors, the HttpApi spec
packages/client             HttpApiClient-based client + live WebSocket (tickets, reconnect, resync)
```

`apps/macos` is outside the Bun workspace. `ShouldertapCore` mirrors `packages/domain` and `packages/client` in Swift (contracts, API client, live socket, store); its tests decode fixtures in the server's JSON shapes. `apps/windows/core` (`shouldertap-core`) is the same in Rust, and its tests decode the same fixtures from `apps/macos/Tests/ShouldertapCoreTests/Fixtures`. Change the protocol in all three places. [Mac client research](docs/research/mac-client-efficiency.md) explains the move from React Native.

## Develop

```bash
bun install
```

```bash
bun run dev            # alchemy dev: API on :3000, web on :3001, Workers and DOs in local workerd; reads shouldertap-dev (see Deploy)
```

```bash
bun run test                                 # unit tests (Vitest), no deploys
```

```bash
cd apps/server && bun run test:local         # integration suite against a local Stack
```

```bash
cd apps/server && bun run test:integ         # same suite, deployed to the test_$USER stage and destroyed after
```

Schema changes: edit `apps/server/src/schema.ts` (Inbox) or `apps/server/src/patron-schema.ts` (SenderPatron), then generate and commit a migration. Each Durable Object applies pending migrations when it activates.

```bash
cd apps/server && bun run db:generate
```

```bash
cd apps/server && bun run db:generate:patron
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

Debug builds talk to `http://localhost:3000` (override with `SHOULDERTAP_SERVER_URL`). Open an invite with `xcrun simctl openurl booted 'shouldertap://join#<code>'`, or paste the link.

Windows app (Rust; see [Windows client research](docs/research/windows-client-efficiency.md)). The UI is [GPUI](https://gpui.rs), so it also runs on a Mac for development: no tray there, the menu opens as a window. Tests, then run it against the local stack:

```bash
cd apps/windows && cargo test --workspace
```

```bash
cd apps/windows && cargo run
```

Dev builds (`cargo build`/`run`) talk to `localhost` (override with `SHOULDERTAP_SERVER_URL` and `SHOULDERTAP_WEB_URL`), run as "Shouldertap Debug" with an orange tray icon, keep their own pairing, and don't install themselves. To build the exe from a Mac, install `cargo install cargo-xwin` and `brew install llvm lld`, then:

```bash
cd apps/windows && scripts/build.sh            # dev build, prints the .exe path
```

## Deploy

Production is the `prod` stage: the site at `https://shouldertap.app` (`www` redirects), the API at `https://api.shouldertap.app`, and Mac downloads at `https://download.shouldertap.app`. Hostnames live in `domains.ts`; other stages stay on `workers.dev`. The domain is registered with Cloudflare Registrar on the same account (auto-renew off, renews 2027-09-30).

GitHub Actions (`.github/workflows/deploy.yml`) lints and type-checks every push and PR (`check`), runs the download-flow browser tests in Playwright's container image (`e2e`, beside `check`), deploys `main` to `prod` (`deploy`), and deploys each PR to a `pr-<number>` preview (`preview`), runs the integration tests against it, comments the links on the PR, and destroys it when the PR closes. Its Cloudflare token is minted by `stacks/github.ts` and stored as repo secrets; the same stack creates the `production` environment below and protects `main`. Deploy it under the `admin` profile once, and again to rotate or rescope the token or change the environment:

```bash
bun alchemy deploy --config stacks/github.ts --profile admin
```

App secrets (`SUPPORT_FORWARD_TO`, a comma-separated list of addresses `support@` forwards to; `CREEM_*` and `APNS_*`) live in Infisical, split across two projects because on the free plan the project is the only access boundary. `alchemy.run.ts` loads them itself through `Config`; `stacks/secrets.ts` holds the project ids and picks the source per stage:

| Stage | Infisical project | Read by |
| --- | --- | --- |
| `prod` | `shouldertap-prod`, env `prod` | CI as `ci-prod`, only in jobs using the `production` environment (main only); the operator's `admin` profile |
| `pr-<number>`, or any other stage deployed from GitHub Actions | none: previews run without app secrets |  |
| anything else (local dev) | `shouldertap-dev`, env `dev` | the `default` profile (`agent-dev`) |

`stacks/github.ts` creates the `production` GitHub environment (deployable from `main` only) with the variables `INFISICAL_IDENTITY_ID` (`ci-prod`) and `INFISICAL_OIDC_AUDIENCE`. In `deploy.yml` only the `deploy` (prod) job uses it; Alchemy logs in to Infisical with that job's OIDC token. `release.yml`'s jobs use it too, loading release keys with `Infisical/secrets-action`.

Every Infisical identity (`agent-dev`, `operator`, `ci-prod`) is read-only. Add or rotate prod secrets yourself in the Infisical dashboard.

Locally Alchemy uses the selected profile's Infisical identity. Set one up once per machine, with that identity's `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` exported:

```bash
bun run setup:infisical                      # default profile: agent-dev, for dev stages
```

```bash
bun run setup:infisical -- --profile admin   # admin profile: operator, for prod (the owner's Mac only)
```

To plan or deploy prod by hand:

```bash
bun alchemy plan --stage prod --profile admin
```

```bash
bun alchemy deploy --stage prod --profile admin --yes
```

`dev` is a scratch stage: web `https://shouldertap-web-dev-np4ztb2ul2oajd6h.jakebodea.workers.dev`, API `https://shouldertap-server-dev-rtv4iyushaacenl3.jakebodea.workers.dev`.

## Release the iOS app

Archive, sign for App Store distribution (team `6C46GY4Z38`, automatic signing through the Apple ID in Xcode or an App Store Connect API key; see the script header) and upload to App Store Connect, where the build shows up in TestFlight after processing:

Label the pull request `release:ios` (`release:beta` still works): when it merges, `.github/workflows/release.yml` runs `scripts/release-ios.sh` on a macOS runner from the merged `main` and comments the build number on the PR. Actions > Release > Run workflow releases `main` on demand. By hand, `bun run release:ios` loads the same key through the Alchemy `admin` profile. CI signs with an App Store Connect API key (Admin role, so it can create the distribution certificate) from Infisical `shouldertap-prod` (`prod`): `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (the `.p8` file's contents).

The app and widget share `apps/ios/Version.xcconfig`: bump `MARKETING_VERSION` for a new version and increment `CURRENT_PROJECT_VERSION` before an upload. Set `BUILD_NUMBER` only for an intentional override; the release script requires a positive integer. App Store Connect rejects repeated version/build pairs. `--no-upload` exports the `.ipa` only. Release builds talk to production. The app declares `ITSAppUsesNonExemptEncryption = NO` (HTTPS only), so uploads skip the export compliance question.

## Release the Mac app

Mac and Windows share one version (pre-1.0 while big features land; `bun run check` fails if they differ). Bump `CFBundleShortVersionString` and `CFBundleVersion` in `apps/macos/Resources/Info.plist` and `version` in `apps/windows/Cargo.toml` together, then test and build a universal DMG and upload it to the `shouldertap-releases` R2 bucket (needs `wrangler login`):

Label the pull request `release:mac` (or `release:desktop` for Mac and Windows): when it merges, `.github/workflows/release.yml` runs `scripts/release-mac.sh` on a macOS runner, signed with the Developer ID, notarized with the App Store Connect key and the feed signed with the Sparkle key (all from Infisical `shouldertap-prod`), and comments on the PR. It refuses a build that isn't newer than the live feed. By hand, `bun run release:mac` does the same on your Mac. The `native.yml` `mac-package` job packages an unsigned DMG on PRs that touch the release, so CI packaging breaks there first.

The keys live in `shouldertap-prod` as `MAC_DEVELOPER_ID_P12`, `MAC_DEVELOPER_ID_P12_PASSWORD` and `SPARKLE_ED_PRIVATE_KEY`. To add or rotate them, run `bun run keys:mac`: it exports both from the login keychain, opens Infisical, puts each value on your clipboard to paste, and checks each one.

It uploads `Shouldertap-<version>.dmg` (immutable), overwrites `Shouldertap.dmg` (the site's Download button), then publishes `appcast.xml`, the [Sparkle](https://sparkle-project.org) feed installed apps check daily. `--no-upload` builds only. `CFBundleVersion` must go up every release; Sparkle compares it.

Updates are signed with an EdDSA key in the login keychain (account `app.shouldertap.mac`); its public half is `SUPublicEDKey` in Info.plist. Without the private key no update can ship to existing installs, so keep a copy somewhere safe, such as a password manager:

```bash
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account app.shouldertap.mac -x shouldertap-sparkle-key.txt
```

Debug builds can rehearse an update against a local feed with `SHOULDERTAP_FEED_URL` and `SHOULDERTAP_UPDATE_SELFTEST=1`, which downloads, installs and relaunches without UI.

Builds are ad-hoc signed until there's an Apple Developer ID, so Gatekeeper makes people click Open Anyway on first launch (the download page explains it). With a Developer ID, set `SIGN_IDENTITY` and either the App Store Connect API key (`NOTARY_KEY`, `NOTARY_KEY_ID`, `NOTARY_ISSUER`; the `ASC_KEY_*` key in Infisical) or `NOTARY_PROFILE` (see the script header) and drop the "Allow it once" step from `apps/web/src/routes/download.tsx`.

## Release the Windows app

Label the pull request `release:windows` (or `release:desktop`): when it merges, `.github/workflows/release.yml` tests and builds the exe on a Windows runner, attests it, runs `scripts/release-windows.sh` with it and creates the `windows-v<version>` GitHub release. By hand: bump `version` in `apps/windows/Cargo.toml` (and the Mac version with it; see above), then build `Shouldertap-Setup-<version>.exe` and upload it to the `shouldertap-releases` R2 bucket under `windows/`, with `windows/latest.json` (`{version, url, sha256}`), the feed installed apps check every 6 hours:

```bash
scripts/release-windows.sh
```

Prefer an exe built on Windows, e.g. the one a `windows-v<version>` tag attaches to its GitHub release (`.github/workflows/windows-release.yml`; then `EXE=<path> scripts/release-windows.sh`): GPUI precompiles its Direct3D shaders only on a Windows host, so exes cross-built on a Mac compile them at launch. `--no-upload` builds only.

The exe installs itself: run from Downloads, it copies itself to `%LocalAppData%\Programs\Shouldertap`, adds a Start menu entry, an entry in Settings › Apps (which runs `--uninstall`) and the login item, and starts from there. `--install --silent` and `--uninstall --silent` are there for winget. Updates download the new exe, check its SHA-256 (and, once releases are signed, its Authenticode signature), swap it in and restart.

Releases are unsigned until Azure Artifact Signing is set up, so SmartScreen warns on first run; set `SIGN_COMMAND` (see the script header) to sign. The site doesn't link Windows downloads yet: add them to `domains.ts`, `alchemy.run.ts` and `apps/web/src/routes/download.tsx` once a signed build is up, and update the privacy policy (older Windows apps send a salted hardware fingerprint during setup (now ignored by the server), and the app checks `download.shouldertap.app` for updates).

## Known gaps in v0

- No accounts: trust is invite links plus revocable bearer credentials. Anyone can create a new (empty) inbox, rate-limited to 10 per client IP per minute (Cloudflare's approximate, per-location limiter). Running the integration suite uses up that budget for a minute.
- The Mac credential lives in an owner-only file in `~/Library/Application Support/Shouldertap`, not the Keychain, because builds are ad-hoc signed (no Developer ID), so the Keychain would prompt after every rebuild.
- The overlay can't be dismissed without answering. If the Mac is offline, answering still dismisses locally and the reply is retried until the server accepts it.
- The Windows app has been built and run only on a Mac (the shared UI and protocol, against the local stack). Its Windows-only parts (tray, overlays above full-screen apps, keyboard focus, Credential Manager, install and update) compile but haven't run on Windows yet. GPUI has no screen reader support yet, unlike the Mac app's SwiftUI.
- Handled in code but not yet tested by hand: Durable Object hibernation, sleep/wake, display hot-plug, full-screen apps/Spaces, and replying while offline. Tested: overlays on two displays, replying from the overlay, cross-Mac dismissal, and the protocol via the Alchemy integration suite.
- Sender history is capped at 50 recent taps.
- Core messaging is free. Legacy plan snapshots emit `paid` solely to keep old desktops usable; historical trials and purchases remain stored. Optional patron support is $2/month, billed $24 annually, and belongs to the sender. See [patron billing and rollout](docs/patrons.md) for the implementation, identity, provider configuration and verification limits.
- Sender themes: a patron's taps carry a theme (Broadsheet, Billboard, Terminal, Note) chosen on the web sender's Style page; Mac and Windows draw each tap in its sender's theme, and recipients can reduce motion for free. The iPhone sender sends Default (no in-app purchase). Patron identities have no self-service recovery if every linked device is lost. The Windows renderers and Appearance window have been run only on a Mac (GPUI). See [patrons.md](docs/patrons.md#sender-themes).
- Limits, enforced by the Inbox: 30 taps per sender per rolling hour (`TooManyRequests`, 429; retries of an existing request id still succeed), and 20 active senders and 10 active devices per inbox (`Conflict`, 409, from `createInvite` and `redeemInvite`).
- Retention: a daily Durable Object alarm (Alchemy's `scheduleEvent`, armed at inbox creation and on any activation) deletes taps older than 90 days, invites a day after they expire, expired connect tickets, and removed pairings 90 days after removal once none of their taps remain. See `apps/server/src/retention.ts`. On the Workers Free plan each alarm run counts toward the 100,000 Durable Object requests per day, so that's one request per inbox per day.

## Phone-first access and rollout

An iPhone can create an inbox, invite by link/QR, receive and answer without a Mac. Creator credentials retain platform `iphone`; removing a computer never disables an inbox that still has phones. Native iPhone sending remains Default-only, with no external checkout controls. Sender-owned patron themes are implemented on the web and desktop receivers; recipient reduced-motion controls remain free. New sender checkout is available when Creem credentials and the annual patron product are configured. Existing management/webhooks remain available.

Candidate release preparation is tracked in [the 0.2.0 checklist](docs/release-0.2.0.md). The API `/version` exposes its Cloudflare version ID, revision tag and free-core/signup state without credentials; production deploys must tag the exact source revision. There is no total-loss owner recovery. Keep another receiver linked before resetting the last one; sender invitations cannot restore ownership. Real physical APNs, Windows hardware and final release/review remain separate verification gates.
