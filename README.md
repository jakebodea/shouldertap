# Shouldertap

A trusted person can send a message that appears across your connected computer displays until you acknowledge it, then receive your response.

[Shouldertap: app idea](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) is the source of truth for the concept. [Architecture plan](docs/architecture.md), [Apple client research](docs/research/apple-clients.md), [backend research](docs/research/backend-stack.md).

## What v0 does

1. **Pair**: the Mac app creates your inbox on first launch. "Create invite link" shows a QR code and link for a sender's phone; "Add another Mac" gives a one-time code for your other Macs.
2. **Send**: the sender opens the link in Safari, enters their name, and sends a tap (quick templates or free text).
3. **Pause**: every paired Mac covers every display with the message, above full-screen apps and on every Space.
4. **Respond**: ✅ On it, ⏱️ In 10 min, or a typed reply. Answering on one Mac dismisses it on all of them.
5. **Close the loop**: the sender sees delivered → on screen → the reply, live.

## Layout

```text
apps/server     Hono ingress + Inbox Durable Object (SQLite), one per recipient
apps/web        Safari sender (React, TanStack Router, Vite)
apps/macos      React Native macOS menu-bar app + Swift overlay/bridge module
packages/domain Effect Schema contracts, token format, response presets
packages/client HTTP client + live WebSocket (tickets, reconnect, resync)
packages/infra  Alchemy v2 stack: server Worker, DO namespace, web Worker
```

`apps/macos` is deliberately outside the Bun workspace (npm, hoisted `node_modules` for CocoaPods and Metro). Its Metro config compiles `packages/domain` and `packages/client` from source.

## Develop

```bash
bun install
```

```bash
bun run dev            # alchemy dev: API on :3000, web on :3001
```

```bash
bun apps/server/scripts/smoke.ts            # protocol end-to-end check (local)
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

Debug builds talk to `localhost`; Release builds use the deployed `dev` stage (`apps/macos/src/config.ts`). In debug, `globalThis.__shouldertap` exposes the store and native module to a debugger.

## Deploy

```bash
cd packages/infra && bunx alchemy deploy --stage dev
```

After a deploy that changes URLs, update `deployed` in `apps/macos/src/config.ts` and rebuild the Release app:

```bash
cd apps/macos/macos && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Shouldertap.xcworkspace -scheme Shouldertap-macOS -configuration Release -derivedDataPath build -destination 'platform=macOS,arch=arm64' build
```

Current `dev` stage: web `https://shouldertap-web-dev-np4ztb2ul2oajd6h.jakebodea.workers.dev`, API `https://shouldertap-server-dev-rtv4iyushaacenl3.jakebodea.workers.dev`.

## Known gaps in v0

- No accounts: trust is invite links plus revocable bearer credentials. Anyone can create a new (empty) inbox; there's no rate limiting yet.
- The Mac credential lives in an owner-only file in `~/Library/Application Support/Shouldertap`, not the Keychain, because builds are ad-hoc signed (no Developer ID), so the Keychain would prompt after every rebuild.
- The overlay can't be dismissed without answering. If the Mac is offline, answering still dismisses locally and the reply is retried until the server accepts it.
- Handled in code but not yet tested by hand: Durable Object hibernation, sleep/wake, display hot-plug, full-screen apps/Spaces, and replying while offline. Tested: overlays on two displays, replying from the overlay, cross-Mac dismissal, and the protocol against the deployed API.
- Sender history is capped at 50 recent taps.
