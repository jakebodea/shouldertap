# Shouldertap backend and tooling research

Checked **2026-09-30** against first-party documentation, published npm metadata, and source. This is a proposed architecture; no packages were installed, applications generated, infrastructure provisioned, or runtime compatibility tested.

The local README defines the product as a trusted person sending a message across the recipient's connected computer displays until acknowledgement, followed by a response. The user subsequently narrowed v0 to a Safari sender on iPhone/iPad and a native Mac receiver, while retaining a native iPhone/iPad companion as a future requirement. The selected client direction is **React Native macOS with a small Apple native module**, and a future **Expo iOS companion**. The original Native SDK alternative is covered separately.

## Recommendation

Start with **a TypeScript workspace, a small web sender, one Cloudflare API Worker, one SQLite-backed Durable Object per recipient, and one D1 database for Better Auth accounts/sessions**. Use Alchemy to declare/deploy these resources and Effect for backend services, errors, schemas, and client networking where the selected native runtime supports it. Keep the public protocol ordinary JSON over HTTPS and WebSockets. This topology is a design inference from the documented capabilities below, not a vendor-prescribed template.

| Component | Responsibility | v0 choice |
| --- | --- | --- |
| Safari web app | Sign in, select trusted recipient, send, view receipt/response | React + TanStack Router/Vite; no SSR requirement |
| API Worker | Account authentication, request validation, recipient routing, device-pairing endpoints | Effect services; thin Hono ingress if using the Better T Stack generator |
| Recipient Durable Object | Authoritative trusted-sender grants, receiver devices, taps, acknowledgements, responses; coordinate connected Macs | SQLite storage + hibernating WebSockets |
| D1 | Better Auth users, accounts, sessions; optional nonauthoritative directory metadata | Drizzle adapter if retaining generated Better T Stack auth |
| Alchemy | Resource declarations, bindings, stages, deployments, migrations, infrastructure state | Explicitly pinned v2 beta lane, see version caveat |
| Ultracite | Root lint/format configuration | Explicitly choose Biome or Oxlint; avoid implicit conflicting defaults |

Workers and Durable Objects can serve WebSockets; Durable Objects coordinate several clients and can hibernate while connections remain open. SQLite-backed DO storage is private to an instance, transactional, and strongly consistent. D1 provides relational SQLite via a Worker binding. [Cloudflare WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [DO SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Alchemy D1](https://alchemy.run/cloudflare/data/d1/).

Skip Queues, Cloudflare Workflows, R2, KV, containers, and external Postgres in v0. A persisted pending tap plus reconnect synchronization handles an offline Mac without a job orchestrator. Add push delivery and a durable external-delivery outbox when the mobile app or offline notifications require them. Add alarms only for a concrete deadline/reminder requirement; Cloudflare alarm execution is at least once, so handlers must be idempotent. [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

## Version compatibility is the main setup trap

The user-requested [Alchemy llms.txt](https://alchemy.run/llms.txt) was explicitly fetched. It now indexes **Alchemy v2 / Infrastructure as Effects**, including Workers, DOs, hibernating WebSockets, D1, Effect HTTP/RPC, and Better Auth guides. It is a navigation index, not a guarantee of stable APIs. Alchemy's current install guide explicitly pairs `alchemy@latest` with `effect@rc` and RC platform packages. [Getting started](https://alchemy.run/getting-started/).

Published npm metadata on the checked date:

| Package | Published lane | Verified version |
| --- | --- | --- |
| `alchemy` | `latest`, **beta** | `2.0.0-beta.79` |
| `effect` | `latest`, stable | `3.22.2` |
| `effect` | `rc`, **release candidate** | `4.0.0-rc.118` |
| `create-better-t-stack` | `latest` | `3.44.2` |
| `ultracite` | `latest` | `7.12.2` |
| `better-auth` | `latest` | `1.7.6` |
| `@effect/sql-d1` | `latest`, Effect 3 driver | `0.50.0` |
| `@effect/sql-d1` | `rc`, Effect 4 driver | `4.0.0-rc.118` |
| `@effect/sql-sqlite-do` | `rc`, Effect 4 driver | `4.0.0-rc.118` |
| `@alchemy.run/better-auth` | `latest`, **beta** | `2.0.0-beta.79` |

Sources: publisher-owned [Alchemy metadata](https://registry.npmjs.org/alchemy), [Effect metadata](https://registry.npmjs.org/effect), [Better T Stack metadata](https://registry.npmjs.org/create-better-t-stack), [Ultracite metadata](https://registry.npmjs.org/ultracite), [Better Auth metadata](https://registry.npmjs.org/better-auth), [D1 driver metadata](https://registry.npmjs.org/@effect%2Fsql-d1), [DO driver metadata](https://registry.npmjs.org/@effect%2Fsql-sqlite-do), [Alchemy auth metadata](https://registry.npmjs.org/@alchemy.run%2Fbetter-auth).

`alchemy@2.0.0-beta.79` requires Effect `>=4.0.0-rc.115 || >=4.0.0`; stable Effect 3 does not satisfy it. The published Better T Stack **3.44.2 template generator already emits Alchemy v2**, and its dependency table pins Alchemy `2.0.0-beta.79`, Effect `4.0.0-rc.115`, and the Node/Bun platform packages at the same RC. This was checked by reading the published tarball without running it. Its website's general “stable by default” wording does not describe this selected deployment lane. [Immutable Alchemy package metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.79), [published template generator](https://registry.npmjs.org/@better-t-stack%2Ftemplate-generator/3.44.2), [Better T Stack philosophy](https://www.better-t-stack.dev/docs/).

**Recommended choice for this exploratory repo:** accept the beta/RC lane deliberately and pin one coherent package family. If scaffolding from BTS 3.44.2, first use its RC.115 baseline; upgrading to RC.118 should update all Effect integration packages together and be tested. Avoid casually installing `effect@latest` or `@effect/sql-d1@latest` into that scaffold. The D1 guide's unqualified driver install command requires version correction when used with Alchemy v2. [Alchemy Effect SQL D1 guide](https://alchemy.run/sql/effect-sql/d1/).

A more conservative alternative is the old async Alchemy generation with stable Effect 3 runtime code. The docs call that generation “v1,” but npm's last non-prerelease release found was `0.94.0`, not `1.x`. This alternative uses [v1.alchemy.run](https://v1.alchemy.run/), would need deliberate template changes, and sacrifices the current Effect-native integration. Its infrastructure state is incompatible with v2 state. [Migration guide](https://alchemy.run/migrating-from-v1/), [Alchemy release metadata](https://registry.npmjs.org/alchemy).

## One durable owner for each tap

The following is a proposed domain design. Keep message state in the **recipient DO's SQLite database only**; D1 is not a second authoritative message store.

1. The sender posts a tap with a stable request ID. The Worker validates the account session and forwards a verified actor through its internal DO binding.
2. The recipient DO checks its authoritative sender grant and inserts the tap plus an event sequence in one storage transaction. The same request ID/payload returns the original tap on retry; reusing it with a different payload is a conflict.
3. After committing, broadcast the new state to connected recipient devices. A successful socket write is neither human acknowledgement nor proof that an overlay was displayed.
4. On startup, wake, reconnect, or a sequence gap, the Mac fetches the authoritative pending snapshot. A lost broadcast cannot lose the tap.
5. A Mac submits acknowledgement/response via authenticated HTTP. The DO atomically transitions `pending → acknowledged`, preserving the first acknowledgement and its response. Concurrent acknowledgements return the committed result.
6. Broadcast that committed state to every recipient device so overlays dismiss together. An authorized, read-only sender subscription receives the status/response for its messages from the same DO. Keep its session lifetime bounded and propagate revocation; HTTPS status reads recover missed events. Foreground polling is a recovery fallback, not the planned primary response path.

Suggested durable fields: `tapId`, `requestId`, `senderId`, `recipientId`, `body`, `createdAt`, `state`, `acknowledgedAt`, `acknowledgedByDeviceId`, `response`, and `sequence`. Use a separate delivery/display receipt if needed. Make acknowledgement global to the recipient; individual display dismissal is a local Mac concern. Acknowledgement persistence also survives a receiver that disconnects before seeing the success response.

Alchemy v2 documents a DO class extending `Cloudflare.DurableObject<Inbox>()`, with an outer construction Effect and an inner instance Effect. Yielding that class in a Worker constructor registers its namespace and migration metadata; `getByName(recipientId)` routes to the stable recipient instance. Its SQL migrations run as each instance activates. These are documented capabilities, not an integration tested in this repo. [Alchemy Durable Objects](https://alchemy.run/cloudflare/compute/durable-objects/).

Cloudflare provides `transactionSync` for synchronous SQL operations and forbids returning a Promise from its callback. Wrap the atomic SQL block at the Effect boundary; do not insert asynchronous network work into it. DO serialization alone does not make arbitrary storage plus remote API calls one transaction. Alchemy also documents an Effect-native `state.storage.transaction` wrapper; choose one storage adapter consistently and validate its SQL semantics. [DO storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Alchemy DO transactions](https://alchemy.run/cloudflare/compute/durable-objects/).

Hibernation resets in-memory maps and reruns the constructor. Restore socket metadata using `getWebSockets` and serialized attachments; attachments last only as long as the connection. Store pending taps/acknowledgements in SQLite, not attachments. Avoid permanent intervals/fibers that defeat hibernation. Alchemy documents Effect-native websocket handlers and restoration. [Cloudflare WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Alchemy hibernation guide](https://alchemy.run/cloudflare/compute/hibernatable-websockets/), [Cloudflare in-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).

## Authentication, trust, and revocation

Better Auth on D1 is a credible account/session choice, with official Drizzle support and an Alchemy Effect/D1 integration. Alchemy's native auth integration is itself beta, expects Kysely for the native D1 adapter, and documents additive migrations plus the absence of interactive D1 transactions. Do not activate plugins requiring interactive transactions. Choose either generated Better Auth + Drizzle or Alchemy's native D1 auth layer; avoid two migration owners for the same auth tables. [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), [Alchemy D1 auth guide](https://alchemy.run/better-auth/databases/cloudflare-d1/).

Proposed authorization boundaries:

- **D1/Better Auth owns browser identity and account sessions.** Revalidate a session on each authenticated HTTP mutation/read; do not accept a client-supplied actor ID as identity.
- **The recipient DO owns trust grants and paired receiver devices.** Keep these authoritative grants beside the taps. Check the sender grant inside the same atomic tap-acceptance block. Grant revocation racing a send then has one ordering point.
- **Native pairing is an explicit adapter.** A Mac opens browser sign-in/approval and redeems a one-time pairing code for a revocable device credential stored in Keychain. Verify that credential against the DO device grant for native acknowledgements. This is application work to design/test, not an existing Better Auth Native SDK integration claim.
- **WebSocket upgrades use short-lived, one-time connect tickets.** Exchange the authenticated session/device credential over HTTPS; consume the ticket in the DO. Do not put a persistent credential in a socket URL. Associate sockets with device/grant IDs and close them when that grant is revoked.
- **Logout and device unpairing have separate meanings.** Browser logout revokes its account session; native unpairing revokes its DO device credential and connections. Account deletion must revoke recipient devices/grants before removing the account, with retryable cleanup. Do not imply browser logout automatically invalidates a separately paired Mac.

Keep all v0 commands on HTTP and use receiver/sender WebSockets for authorized server events, which avoids making a long-lived socket an indefinitely trusted mutation channel. Sender subscriptions need bounded session expiry, filtering to authorized message events, and explicit revocation propagation. D1 metadata may index recipients for browsing, but must not independently authorize a send after its DO grant has been revoked.

The future Expo companion can use Better Auth's official Expo plugin and secure storage, but that plugin does not establish React Native macOS or the experimental Native SDK integration. [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo).

## Effect scope and a portable wire protocol

Use Effect heavily in the backend: Schema at trust boundaries, tagged domain errors, services/layers for inbox/auth/storage/native adapters, bounded retries for idempotent transient failures, and request-scoped cancellation. Alchemy distinguishes resource construction/planning from handlers that execute in the deployed Worker; its infrastructure state is deployment bookkeeping, separate from application inbox data. [Alchemy phases](https://alchemy.run/infrastructure-as-effects/phases/), [state store](https://alchemy.run/state-store/).

Prefer **Effect HttpApi with JSON** for commands and **versioned JSON websocket envelopes** for events. HttpApi can derive a typed Effect client while still serving plain HTTP consumers. Effect RPC is reasonable when every client supports its runtime, but should not constrain the native client choice. [Effect HTTP](https://alchemy.run/apis/effect-http/), [Effect RPC](https://alchemy.run/apis/effect-rpc/).

Suggested packages: `protocol` for neutral serializable types/event versions; `domain` for Effect schemas and domain rules; `client` for HTTP/socket adapters; and `infra` for Alchemy. Browser/server can share Effect schemas. React Native may share the same source once tested. A restricted native compiler can consume generated declarations/OpenAPI or a small protocol adapter without importing Effect. Keep cloud bindings, Node/Bun platform packages, auth secrets, and infrastructure imports out of shared client packages.

The official Effect repository ships a React Native SQLite integration separately from core Effect and its platform packages. React Native provides Fetch, Promise/async support, and WebSockets. This supports an **inference that portable core Effect plus RN adapters is credible**, not a guarantee for every Hermes/RN macOS combination. Before committing to shared Effect client code, run Schema validation, `Effect.runPromise`, cancellation, Fetch, reconnect, and package-bundling smoke checks on the pinned native runtime. Node/Bun platform packages belong in infrastructure tooling, not a Hermes app. [Effect packages](https://github.com/Effect-TS/effect), [React Native driver source](https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-react-native/src/SqliteClient.ts), [RN networking](https://reactnative.dev/docs/network).

## Better T Stack and Ultracite setup approach

BTS currently supports Workers/Hono, D1/SQLite with Drizzle or Prisma, Better Auth, Expo frontends, Turborepo, and Ultracite. The generator's API choices are `trpc`, `orpc`, or `none`; it does not expose an Effect backend selection. Choose `--api none` to avoid introducing an RPC stack that must later be replaced. Its documented Workers scaffold requires Hono. Use that as thin ingress and put the tap domain in Effect, or create the workspace layout manually if preferring pure Effect HttpApi ingress. [BTS options](https://www.better-t-stack.dev/docs/cli/options), [compatibility](https://www.better-t-stack.dev/docs/cli/compatibility).

For v0, the selected generator inputs should be: package manager **Bun**; web `tanstack-router` (Vite SPA); backend `hono`; runtime `workers`; database `sqlite`; ORM `drizzle`; D1 setup; Better Auth; Cloudflare web/server deployment; `api none`; no examples/payments; addons `turborepo` and `ultracite`. TanStack Start adds server rendering that this sender does not yet need. Bun is the local package manager/infra runner; the backend still runs in Cloudflare workerd. Add the React Native macOS app separately: BTS's native frontends are Expo, and its desktop addons are Tauri/Electrobun. Reserve an eventual separate Expo mobile app; do not treat an Expo scaffold as a Mac receiver. [BTS quick start](https://www.better-t-stack.dev/docs/), [Alchemy deployment guide](https://www.better-t-stack.dev/docs/guides/cloudflare-alchemy).

Ultracite **7.12.2** supports Oxlint/Oxfmt, Biome, or ESLint. Its own initializer currently recommends Oxlint, while BTS's Ultracite helper defaults to Biome. Both are valid; choose explicitly and keep one root toolchain. Biome is a reasonable continuity choice if that is the user's established preference. Configure React/Vitest presets actually used by the repo, preserve existing AGENTS.md content, and exclude generated Xcode/build artifacts. Root `ultracite check`/`fix` scripts can cover the workspace; run TypeScript typechecking separately. [Ultracite setup](https://www.ultracite.ai/docs/setup), [monorepos](https://www.ultracite.ai/docs/monorepos), [BTS Ultracite helper source](https://github.com/AmanVarshney01/create-better-t-stack/blob/main/apps/cli/src/helpers/addons/ultracite-setup.ts).

First meaningful validation slice: a Safari sender issues one tap; an online Mac displays it; acknowledgement persists and clears it; a second Mac clears from the same acknowledgement; reconnect/offline retry yields the same receipt; revoked grants and hibernation reconstruction retain correct behavior. Run local workerd integration plus a disposable cloud stage because a successful browser build alone cannot establish DO lifecycle or native networking behavior. Alchemy's dev/test commands can provision resources, so this research did not run them. [Alchemy local development](https://alchemy.run/environments/local-development/), [Alchemy testing](https://alchemy.run/testing/).
