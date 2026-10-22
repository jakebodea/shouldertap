<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

## Repository map

Start with [README.md](README.md) (layout, develop, deploy). Product UI rules: [docs/design.md](docs/design.md) (Frame: person color on the frame, ink on paper). System shape: [docs/architecture.md](docs/architecture.md).

| Change | Touch |
| --- | --- |
| HTTP / WebSocket protocol | `packages/domain`, `apps/server`, `ShouldertapCore` (`apps/macos`), `apps/windows/core` — `bun run check` runs `scripts/check-protocol-sync.mjs` |
| Desktop UI (menu, onboarding, settings) | Both `apps/macos` and `apps/windows`, same features — `bun run check` runs `scripts/check-desktop-parity.ts`; list new labels there |
| Safari framed pages | `apps/web/src/components/frame.tsx`, `safari-edge-strips.tsx`, `index.css` — not Playwright tint tests (`apps/web/e2e/README.md`) |
| iOS sheets from frame UI | Apply `.sheetOnPaper()` on sheet content (`apps/ios/Shouldertap/Theme.swift`) |
| PR preview lifecycle | `scripts/cloudflare/previews.ts` + tests — not ad hoc worker-name parsing in YAML |

The Mac and Windows apps are one product: keep their features and overall UI (layout, flows, wording) in parity. Change both in the same PR; differ only where the platform does (menu bar vs tray, install). Render the Windows side on a Mac (`apps/windows`, GPUI) to check it.

Native apps are outside the Bun workspace: run `swift test` / `cargo test` when changing protocol mirrors (see `.github/workflows/native.yml`).

## Tests

- Test behavior, not implementation. Call the code the way its users do and assert a literal expected value from an independent source (a worked example or the spec), never one recomputed the way the code computes it. Keep a test only if it would fail when every function it imports returned `undefined`: rewrite or delete tests whose only assertions are calls made (`toHaveBeenCalled*`), absence (`toBeUndefined`, `toEqual([])`), a restated constant, or data the test built itself.
- Fake only real system boundaries (external APIs, time, randomness, platform APIs) and pass them in; never mock the project's own modules. Freeze the clock in any test whose result depends on today's date.
- `lint/oxlint-plugin-test-quality.mjs` catches the common shapes in `bun run check`: tests whose only assertions are weak, expected values computed by the module under test, and tests that run no code. Disable a rule only with a written reason.
- Prefer the tests that run the real thing: `apps/server` integration tests against a deployed preview and the Playwright download flows in `apps/web/e2e` (download flow only; see `apps/web/e2e/README.md`).
- Preview deploy/cleanup: extend `scripts/cloudflare/previews.ts` and its tests; do not parse Alchemy worker names in workflow YAML alone.

## Agent secrets (Infisical)

- Secrets come from Infisical through Alchemy (`Infisical.Secrets` in each stack). `stacks/secrets.ts` holds the project ids and maps stage → source: `prod` reads `shouldertap-prod`, `pr-*`/CI previews read nothing from Infisical, everything else reads `shouldertap-dev`.
- Who can read what: Alchemy `default` profile = `agent-dev` (`*-dev` only); `admin` profile = `operator` (all; the owner's Mac only, pass `--profile admin`); CI = `ci-prod` via GitHub OIDC, only in jobs using the `production` environment (main only).
- Agent setup, once per machine: export `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET`, then `bun run setup:infisical`.
- Never add prod values to `shouldertap-dev`, never give a PR job the `production` environment, and never read secrets via `process.env` in stacks (use `Config`).
- `stacks/github.ts` owns the `production` environment (main only) and its `INFISICAL_IDENTITY_ID`/`INFISICAL_OIDC_AUDIENCE` variables; `stacks/secrets.test.ts` fails if it allows another branch. In `deploy.yml` only the `deploy` (prod) job uses it, never `preview`.
- `release.yml` isn't an Alchemy stack: its jobs use the `production` environment and `Infisical/secrets-action` for release keys.
- Every Infisical identity is read-only. Prod secrets are added or rotated by the owner in the dashboard (`bun run keys:mac` walks through the Mac keys); never script writes.
