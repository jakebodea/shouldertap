# Alchemy beta 82 rollout

This change pins Alchemy to `2.0.0-beta.82` and moves the Effect catalog, platform packages, SQLite DO driver, Vitest integration, and overrides to the published stable `^4.0.3` family. Commit the regenerated Bun lockfile; all machines and jobs must install it with Bun 1.4.2. The CLI needs Node **24.11.1 or newer**, or Bun. CI checks use Node 24.11.1; Alchemy deployment and cleanup commands use Bun.

Source: [beta 82 release](https://alchemy.run/blog/2026-10-12-beta-82/). The published Alchemy metadata requires Effect `^4.0.0`; the 4.0.3 integrations require Effect `^4.0.3`. Its frontend-frameworks, cloudflare-runtime, node-utils, and floci dependencies resolve to beta 82. No speculative infrastructure or KV conversion is included. The API Worker enables Workers Issues with observability enabled and both logs and invocation logs enabled.

## One-way migration: application and shared state

Beta 82 uploads Durable Objects using declarative `exports` instead of legacy `migrations`. The application Worker exports **Inbox** and **TrialLedger**. Their IDs, bindings, SQLite schemas, SQL migration files, and data stay the same. Once deployed with exports, an older Alchemy version cannot deploy that Worker again. The first deployment after upgrading must use **100% traffic** (no `version.traffic`); this repo currently declares no gradual rollout. A code rollback must keep beta 82 or newer and the stable Effect package family. Removing a binding alone no longer deletes a namespace while its class remains exported; do not remove classes as part of this upgrade.

`Cloudflare.state()` also bootstraps an account-wide **shared state Worker and its Durable Object**. That Worker is subject to the same irreversible exports transition and first-deploy traffic rule. The application stack (`alchemy.run.ts`), cleanup stack (`alchemy.cleanup.ts`), and admin setup (`stacks/github.ts`) use it for cloud operations. The test harness now uses local bookkeeping; a cloud test deploy still compiles the application stack and uses its cloud state. Other repositories sharing this account must upgrade their deployment tools together, including old branches and open PRs. Even `plan`, state reads, or cloud tests can initialize the backend; command names are not evidence that a command is read-only. Do not run an old CLI against the shared store after it migrates.

Coordinate and pause cloud-running jobs before the first approved deployment. Upgrade every participating checkout, CI job, and repo; stop queued/stale jobs using pre-beta-82 lockfiles. Keep state and SQLite data intact. Run no migration, adoption, deletion, credential rotation, or access expansion as part of reviewing this PR.

## Deployment paths to coordinate

- `.github/workflows/deploy.yml`: main deploys production; ready PRs deploy `pr-<number>`, read outputs, and drive live integration tests. Draft PRs now run check/e2e only. Marking ready triggers preview deployment and is a separate rollout decision.
- `.github/workflows/preview-cleanup.yml`: closed PR, scheduled, and manual cleanup jobs check out main and destroy closed previews using `alchemy.cleanup.ts`. These must use the upgraded main lockfile before any exports migration; keep old queued runs paused. This change does not execute cleanup.
- Local `bun run deploy`, `plan`, `dev`, and `destroy`, including README's Infisical commands: install the upgraded lockfile first. Treat cloud-backed validation as a deployment operation.
- `bun alchemy deploy --config stacks/github.ts --profile admin`: uses the shared state backend and manages credentials/access. Do not run it for this upgrade.
- `apps/server` integration harness: `test:integ` without `STACK_URL` provisions and destroys a cloud test stage; CI supplies an existing preview URL. `test:local` sets `ALCHEMY_DEV=1`. The application stack selects `Alchemy.localState()` from `AlchemyContext.dev`; the harness also uses local state. Installed beta 82 `Test/Core.resolveDev`, `Stack.evalStack`, and `Local/ProviderLayer.dual` select local providers. Local proof uses a fresh `/tmp` `ALCHEMY_HOME`, unset cloud credentials/`STACK_URL`/`PULL_REQUEST`/`ALCHEMY_TEST_DEV`, and disabled telemetry.
- Native Mac/iOS/Windows release scripts and workflows build clients or upload artifacts; they do not deploy the Alchemy stack and are outside this dependency upgrade.

## PR 16 and proof limits

[PR 16](https://github.com/jakebodea/shouldertap/pull/16) adds a narrow retry for missing placeholder DO methods on a fresh deploy. Beta 82 fixes the upstream placeholder path. Keep that PR open and unchanged; reassess its workaround after an approved fresh-stage beta 82 deployment. Local workerd cannot reproduce Cloudflare's post-deploy version skew, so local success does not prove the remote placeholder window is gone.

Local SQLite, trial persistence, WebSocket delivery, first acknowledgement, revocation, reconnect/resync, and retention checks are the relevant runtime gates. Cloud-backed plan/deploy, fresh-stage smoke tests, first exports migration, provider compatibility, and live hibernation are intentionally outside the offline review. Local workerd cannot prove remote migrations or live hibernation.

Worker/Lambda bundles now live under `.alchemy/bundles` rather than `dist/`; their changed sourcemap paths cause a redeploy once. The Vite website still builds `apps/web/dist`, so its existing Turborepo output setting remains correct.

## Offline validation

On this Mac (Bun 1.4.2, Node 26.8.2): frozen-lockfile install, `bun run check`, `bun run check-types`, `bun run test` (82 assertions), and `bun run build` pass. The local server suite passes all 40 assertions (31 unit + 9 integration), including SQLite-backed pairing, live taps/first acknowledgement, revocation, reconnect/resync, trial-ledger reuse, and limits; it also completes local teardown. WebKit download-flow tests pass 3/3 with the browser installed under `/tmp`.

The first local runtime attempt failed because Alchemy's profile store tried to chmod the existing profile; the sandbox rejected it. Tests were rerun with a fresh `/tmp` profile. Restricted loopback binding and a missing WebKit binary also blocked initial attempts; those environment blockers were resolved without modifying existing credentials. A subsequent runtime attempt passed all assertions but timed out during teardown: beta 82's Vitest adapter assumes hooks run in registration order, whereas Vitest defaults to reverse order. `apps/server/vitest.config.ts` now uses `sequence.hooks: "list"`, so the local destroy hook runs before Alchemy closes its sidecar. The rerun passes in about 12 seconds. CI now exercises this local path with an isolated profile and no Cloudflare credentials.

Cloud-backed Alchemy CLI validation, remote deployment tests, exports migration, production smoke tests, native-client builds, and live hibernation were not run. The PR stays draft and CI must skip its deployment job.
