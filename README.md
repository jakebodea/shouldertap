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
apps/server/src/schema.ts   Drizzle schema; migrations in apps/server/drizzle (drizzle-kit, durable-sqlite)
apps/server/test/           Alchemy Test harness: deploys the Stack, drives the protocol
apps/web                    Safari sender (React, TanStack Router, Vite) via Cloudflare.Website.Vite
apps/macos                  React Native macOS menu-bar app + Swift overlay/bridge module
packages/domain             Effect Schema contracts, typed errors, the HttpApi spec
packages/client             HttpApiClient-based client + live WebSocket (tickets, reconnect, resync)
```

`apps/macos` is deliberately outside the Bun workspace (npm, hoisted `node_modules` for CocoaPods and Metro). Its Metro config compiles `packages/domain` and `packages/client` from source.

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

Mac app (needs Xcode and CocoaPods; `DEVELOPER_DIR` avoids `sudo xcode-select`):

```bash
cd apps/macos && npm install && npm run pods
```

```bash
cd apps/macos && npm start        # Metro, keep running
```

```bash
cd apps/macos/macos && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Shouldertap.xcworkspace -scheme Shouldertap-macOS -configuration Debug -derivedDataPath build build && open build/Build/Products/Debug/Shouldertap.app
```

Debug builds talk to `localhost`; Release builds use production (`apps/macos/src/config.ts`). In debug, `globalThis.__shouldertap` exposes the store and native module to a debugger.

## Deploy

Production is the `prod` stage: the site at `https://shouldertap.app` (`www` redirects), the API at `https://api.shouldertap.app`, and Mac downloads at `https://download.shouldertap.app`. Hostnames live in `domains.ts`; other stages stay on `workers.dev`. The domain is registered with Cloudflare Registrar on the same account (auto-renew off, renews 2027-09-30).

```bash
bun run plan -- --stage prod
```

```bash
bun run deploy -- --stage prod --yes
```

`dev` is a scratch stage: web `https://shouldertap-web-dev-np4ztb2ul2oajd6h.jakebodea.workers.dev`, API `https://shouldertap-server-dev-rtv4iyushaacenl3.jakebodea.workers.dev`.

## Release the Mac app

Bump `MARKETING_VERSION` in the Xcode project, then build a universal DMG and upload it to the `shouldertap-releases` R2 bucket (needs `wrangler login`):

```bash
scripts/release-mac.sh
```

It uploads `Shouldertap-<version>.dmg` (immutable) and overwrites `Shouldertap.dmg`, which the site's Download button points at. `--no-upload` builds only.

Builds are ad-hoc signed until there's an Apple Developer ID, so Gatekeeper makes people click Open Anyway on first launch (the download page explains it). With a Developer ID, set `SIGN_IDENTITY` and `NOTARY_PROFILE` (see the script header) and drop the "Allow it once" step from `apps/web/src/routes/download.tsx`.

## Known gaps in v0

- No accounts: trust is invite links plus revocable bearer credentials. Anyone can create a new (empty) inbox, rate-limited to 10 per client IP per minute (Cloudflare's approximate, per-location limiter). Running the integration suite uses up that budget for a minute.
- The Mac credential lives in an owner-only file in `~/Library/Application Support/Shouldertap`, not the Keychain, because builds are ad-hoc signed (no Developer ID), so the Keychain would prompt after every rebuild.
- The overlay can't be dismissed without answering. If the Mac is offline, answering still dismisses locally and the reply is retried until the server accepts it.
- Handled in code but not yet tested by hand: Durable Object hibernation, sleep/wake, display hot-plug, full-screen apps/Spaces, and replying while offline. Tested: overlays on two displays, replying from the overlay, cross-Mac dismissal, and the protocol via the Alchemy integration suite.
- Sender history is capped at 50 recent taps.
