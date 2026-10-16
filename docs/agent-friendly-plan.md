# Agent-friendly plan for Shouldertap

Evidence mined from **52 merged PRs** (all authored by Jake Bodea; **~39 commits** co-authored by Claude/Cursor agents), **git history**, and **fix-up PRs** where agent work was corrected. No pstack skills (`poteto-mode`, `correct`, `architect`) are installed in this environment; recommendations follow the same inverse-pyramid principle Jake already applied in [#46](https://github.com/jbolabs/shouldertap/pull/46) and `lint/oxlint-plugin-test-quality.mjs`.

**Prototype branch (open question: can protocol constants be checked mechanically?):** [`cursor/prototype-swatch-sync-check-61f1`](https://github.com/jbolabs/shouldertap/tree/cursor/prototype-swatch-sync-check-61f1) — a root `bun` script that parses `packages/domain/src/colors.ts` and `apps/macos/Sources/ShouldertapCore/Models.swift` / `apps/windows/core/src/models.rs` and fails on drift.

---

## How Jake steers agents today (recurring themes)

| Theme | What Jake does | Evidence |
| --- | --- | --- |
| Delete tests that do not catch real failures | Whole PR dedicated to pruning | [#36](https://github.com/jbolabs/shouldertap/pull/36) (`53381d9`): −248 lines `mobile-frame.spec.ts`, −78 `check-safari-tint.py`, −98+101 iOS UITests, −17 `wipe-geometry.spec.ts` |
| Encode test philosophy in CI, not prose | Custom oxlint plugin + `AGENTS.md` | [#46](https://github.com/jbolabs/shouldertap/pull/46) (`7742cb0`), [#47](https://github.com/jbolabs/shouldertap/pull/47) (`9000694`) |
| Fix Safari/Frame at the component layer | Edge strips + shared CSS, not more Playwright | [#5](https://github.com/jbolabs/shouldertap/pull/5) (`27adf23`) added heavy e2e; [#51](https://github.com/jbolabs/shouldertap/pull/51) (`b1643c1`) fixed with `.safari-edge` / `frame-edge-*` in `frame.tsx` + `index.css` |
| Fix iOS sheet contrast once in UI | `.foregroundStyle(Color.primary)` on sheets | [#33](https://github.com/jbolabs/shouldertap/pull/33) (`d7c5cd3`, commit `e4f769b` on `codex/ios-help-contrast`) |
| Harden preview lifecycle in code + workflow | Dedicated cleanup workflow + pure functions | [#44](https://github.com/jbolabs/shouldertap/pull/44) (`1f16c32` / `5ae6126`): +`scripts/cloudflare/previews.ts`, +197 lines tests |
| Centralize repo identity | Single owner constant, sweep fixtures | [#52](https://github.com/jbolabs/shouldertap/pull/52) (`8deb63d`): `stacks/github.ts`, `alchemy.run.ts`, `previews.test.ts`, `windows-release.yml` |
| Keep integration tests on real previews | Deploy PR stage, run `apps/server` harness | [#4](https://github.com/jbolabs/shouldertap/pull/4) (`d326aea`) |

---

## Pitfalls ranked by leverage

Effort: **S** (&lt;1 day), **M** (1–3 days), **L** (multi-day). Leverage: how many agent runs avoid a bad diff or a Jake fix-up.

### 1. Tautological or non-observable tests (Leverage: **highest** · Effort: **S** — mostly done)

**Symptom:** Agents add Playwright suites across browsers, geometry unit tests in e2e, iOS UITests that assert labels, or Vitest tests that only check `toBeDefined` / recompute expected values from the module under test.

**Evidence:** [#36](https://github.com/jbolabs/shouldertap/pull/36) explicitly cites Cursor co-authors removing tests that “restate the implementation” or target “one-time Safari behavior.” [#5](https://github.com/jbolabs/shouldertap/pull/5) added those suites; [#36](https://github.com/jbolabs/shouldertap/pull/36) removed them 1 day later.

**Highest-layer fixes already shipped:**

- `lint/oxlint-plugin-test-quality.mjs` + rules in `oxlint.config.ts` (`test-quality/*`).
- `AGENTS.md` Tests section ([#46](https://github.com/jbolabs/shouldertap/pull/46)).
- `anti-slop/no-module-mocking` (no `vi.mock` in repo today).

**Remaining work:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Static | Extend `test-quality` to flag Playwright tests that only `toHaveScreenshot` or only read `getComputedStyle` without a user-visible assertion tied to spec/`docs/design.md` | M |
| Static | Add Swift/Rust analog: a small `swift test` / `cargo test` policy doc is not enough — add **one** shared fixture-decode test per platform (already pattern in `CoreTests`); **fail CI** if `apps/ios` reintroduces a UITest target without an opt-in in `oxlint`/workflow | M |
| Prose (minimal) | Point agents at `apps/web/e2e/README.md` (download-only scope) in `AGENTS.md` — one sentence | S |

---

### 2. Frame / Safari mobile visuals (Leverage: **high** · Effort: **M**)

**Symptom:** Agents set `theme-color` only, use default SwiftUI `.secondary` on sheets opened from a colored frame bar, or add e2e instead of fixed edge strips.

**Evidence:**

- [#51](https://github.com/jbolabs/shouldertap/pull/51) (`b1643c1`): “Framed pages only set theme-color, which Safari ignores.”
- [#33](https://github.com/jbolabs/shouldertap/pull/33) (`d7c5cd3`): Help sheet inherited frame ink; fix `.foregroundStyle(Color.primary)`.
- [#5](https://github.com/jbolabs/shouldertap/pull/5) vs [#36](https://github.com/jbolabs/shouldertap/pull/36): agent-added Safari tint e2e removed as ineffective.

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Codebase | **`Frame` web component always mounts `safari-edge` strips** — done in `apps/web/src/components/frame.tsx` ([#51](https://github.com/jbolabs/shouldertap/pull/51)). **Extract** `SafariEdgeStrip` + shared CSS tokens so new routes cannot forget strips. | S |
| Codebase | **SwiftUI `SheetOnPaper` modifier** (or environment key): any `.sheet` / `.fullScreenCover` from `FrameButtonStyle` / frame navigation applies paper ink + `Color.primary` for system sheets. Replaces ad hoc `.foregroundStyle(Color.primary)` on `HelpView` only. | M |
| Codebase | **`Paper` vs `Frame` text colors as typed styles** in `Theme.swift` / web `index.css` — ban raw `.foregroundStyle(.secondary)` in frame contexts via SwiftLint custom rule (regex allowlist: `Paper.tone`, `Paper.ink`). | M |
| Static | Optional: visual regression **only** for `packages/domain` color contrast math (WCAG on `swatches`) — no browser | S |
| Prose | Link `docs/design.md` “Surfaces” from `AGENTS.md` (Frame invariants: ink on paper, person ink on frame only) | S |

**Prototype answered:** Re-running Safari tint in Playwright cannot see browser chrome; the fix belongs in CSS/components ([#51](https://github.com/jbolabs/shouldertap/pull/51)), not e2e ([#36](https://github.com/jbolabs/shouldertap/pull/36)).

---

### 3. Triplicated wire protocol (TS + Swift + Rust) (Leverage: **high** · Effort: **M**)

**Symptom:** Agents change `packages/domain` or server payloads but not `ShouldertapCore` / `shouldertap-core`, or drift swatch hex values.

**Evidence:** README: “Change the protocol in all three places” (`README.md` § Layout). Manual mirrors: `packages/domain/src/colors.ts`, `apps/macos/Sources/ShouldertapCore/Models.swift`, `apps/windows/core/src/models.rs`. JSON fixtures live under `apps/macos/Tests/ShouldertapCoreTests/Fixtures/`; Rust tests read the same paths.

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Static | **`scripts/check-protocol-sync.mjs`** in CI `check` job: swatches + `maxTapLength` / enum literals (prototype on `cursor/prototype-swatch-sync-check-61f1`) | S |
| Codebase (L) | Generate Swift/Rust swatches from `colors.ts` at build time (codegen in `turbo`/`build`) — eliminates manual copy forever | L |
| Static | On `packages/domain/**` or `apps/server/src/schema.ts` changes, require `swift test` + `cargo test` in a **macOS** workflow (or path-filtered required check) | M |
| Tests | Single golden `fixtures/*.json` exported from server integration test; Swift + Rust decode in CI | M |

---

### 4. Preview deploy / cleanup races (Leverage: **medium-high** · Effort: **S** — largely done)

**Symptom:** Agents edit `.github/workflows/deploy.yml` without understanding Alchemy physical worker names (`shouldertap-server-pr-25-<hash>`), causing previews to respawn after cleanup or leak.

**Evidence:** [#44](https://github.com/jbolabs/shouldertap/pull/44) (`1f16c32`, `5ae6126` on `codex/preview-cleanup-20261008`); `scripts/cloudflare/previews.test.ts` (197 lines).

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Codebase | Keep preview logic in **`scripts/cloudflare/*.ts` only**; workflow calls thin CLI — done | — |
| Static | **Required:** `bun run test:root` already runs preview unit tests if wired in `vitest` — verify `previews.test.ts` is in root vitest include (add if missing) | S |
| Prose | `AGENTS.md`: “Do not parse worker names in YAML; extend `previews.ts` + tests.” | S |

---

### 5. Scattered GitHub `owner/repo` strings (Leverage: **medium** · Effort: **S**)

**Symptom:** Agents hardcode `jakebodea/shouldertap` (old org) in workflows, Alchemy, or test fixtures.

**Evidence:** [#52](https://github.com/jbolabs/shouldertap/pull/52) (`8deb63d`, `b71f49b`); `stacks/github.ts` now `jbolabs/shouldertap`. OIDC audience remains `https://github.com/jakebodea` (user, not org) in `deploy.yml` — intentional.

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Codebase | **Export `GITHUB_REPO` from `stacks/github.ts`** (or `domains.ts`) and import in TS scripts; workflows use `github.repository` env | S |
| Static | oxlint/custom grep in `check`: forbid `jakebodea/shouldertap` except in changelog/historical docs | S |

---

### 6. Alchemy / Effect upgrades and DO migrations (Leverage: **medium** · Effort: **L**)

**Symptom:** Agents bump `alchemy` / `effect` with a large PR, incomplete rollout notes, or local-only validation.

**Evidence:** Open draft [#50](https://github.com/jbolabs/shouldertap/pull/50) (`f672324`): beta 82 + stable Effect 4, explicit “one-way migration” gate; `oxlint.config.ts` documents why type-aware oxlint is off for Effect generators.

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Static | **Pin upgrade PR template** in `.github/pull_request_template.md`: must run `apps/server/test:local`, integ on preview, list DO migration risk | S |
| Codebase | `turbo.json` / root script **`alchemy:doctor`** that fails if lockfile Effect version ≠ `catalog` | M |
| Prose | Keep migration checklist as `docs/alchemy-beta-82.md` (from #50) when that PR lands | S |

---

### 7. Stale or planning-only docs mislead agents (Leverage: **medium** · Effort: **S**)

**Symptom:** Agents scaffold from `docs/architecture.md` “proposed tree” / “scaffolding has not happened” while `apps/server`, Swift Mac, iOS, and Windows exist.

**Evidence:** `docs/architecture.md` header (Sept 30, 2026) contradicts `README.md` Layout section.

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Prose | **Rewrite architecture.md intro** to “current state” + link README; move historical generator notes to `docs/research/` | S |
| Prose | **`AGENTS.md` map**: “Start with `README.md` § Layout & Develop; design in `docs/design.md`; do not create `apps/api`.” | S |

---

### 8. Native apps outside Bun workspace (Leverage: **medium** · Effort: **M**)

**Symptom:** Agents run only `bun run check` and ship Swift/Rust protocol bugs; or add TypeScript in `apps/macos`.

**Evidence:** `oxlint.config.ts` ignores `apps/macos`, `apps/ios`, `apps/windows`. Co-authored Windows ([#38](https://github.com/jbolabs/shouldertap/pull/38) `64d00e1`) and large iOS surface ([#25](https://github.com/jbolabs/shouldertap/pull/25)–[#37](https://github.com/jbolabs/shouldertap/pull/37)).

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Static | **Path-filter workflows**: `swift test` on `apps/macos/**`, `apps/ios/**` changes (macOS runner); `cargo test` on `apps/windows/**` | M |
| Prose | Verification skill (below) lists mandatory native commands | S |

---

### 9. App Store / legal copy drift (Leverage: **lower** · Effort: **S**)

**Symptom:** Agents update `apps/web` privacy/support but not `docs/app-store/en-US.json` or iOS `PrivacyInfo.xcprivacy`.

**Evidence:** [#31](https://github.com/jbolabs/shouldertap/pull/31) (`b56bb3e`) touched web + iOS + docs together; [#32](https://github.com/jbolabs/shouldertap/pull/32) follow-up alignment.

**Highest-layer fixes:**

| Layer | Fix | Effort |
| --- | --- | --- |
| Static | CI grep: shared phrases (“30 days”, support URL) must appear in web + `docs/app-store/en-US.json` | M |
| Prose | `docs/app-store/readiness.md` as single checklist (exists) — link from `AGENTS.md` for iOS tasks | S |

---

## Recommended implementation order

1. **Protocol sync script in `check`** (prototype branch) — cheap, prevents silent drift.
2. **`SheetOnPaper` / Safari edge component extraction** — stops repeat of #33 / #51 classes of bugs.
3. **Update `docs/architecture.md` + `AGENTS.md` repo map** — stops wrong scaffolding.
4. **Path-filter macOS CI for Swift/Rust** — catches protocol edits.
5. **SwiftLint rule for frame text colors** — iOS-specific agent mistakes.
6. **Alchemy upgrade guardrails** when [#50](https://github.com/jbolabs/shouldertap/pull/50) merges.

---

## Proposed verification skill: `verify-shouldertap`

No `verify-*` skill exists in-repo. Add **`.cursor/skills/verify-shouldertap/SKILL.md`** (prose layer only until Jake approves location).

### Always (Linux CI parity — any agent cloud VM)

```bash
bun install --frozen-lockfile
bun run check          # ultracite = oxlint + oxfmt + test-quality rules
bun run check-types
bun run test           # Vitest unit; includes lint plugin tests + cloudflare preview tests
cd apps/server && bun run test:local   # workerd + DO integration (no Cloudflare deploy)
cd apps/web && bunx playwright install webkit && bun run test:e2e   # download flow only
```

### When touching server / protocol / `packages/domain`

```bash
cd apps/server && bun run test:integ   # deploys test stage; needs Cloudflare + Infisical (CI uses preview on PRs)
node scripts/check-protocol-sync.mjs   # after landing prototype
```

### macOS only (menu bar + iOS simulator + notarization)

Requires **Xcode**, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`:

```bash
cd apps/macos && swift test && open "$(scripts/build.sh)"   # debug app → local stack
cd apps/ios && xcodebuild -project Shouldertap.xcodeproj -scheme ShouldertapIOS \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build build
xcrun simctl install booted apps/ios/build/Build/Products/Debug-iphonesimulator/Shouldertap.app
```

Cannot fully verify on Linux: menu-bar overlay on multiple displays, Live Activity, push, notarization, TestFlight ([#29](https://github.com/jbolabs/shouldertap/pull/29)), DMG drag-to-Applications ([#40](https://github.com/jbolabs/shouldertap/pull/40)). Document **manual** steps in `docs/verification/` (see existing `mac-download-flow.md`).

### Windows (optional)

```bash
cd apps/windows && cargo test --workspace && cargo run   # GPUI dev on Mac possible; tray behavior needs Windows 11
```

### PR preview

Merge gate already runs integration tests against `pr-<n>` ([#4](https://github.com/jbolabs/shouldertap/pull/4)). Agent skill should say: **for API changes, wait for preview comment URLs and treat failing `deploy` job as blocking.**

---

## What not to do (human review last resort)

- Do not add multi-browser Playwright for Frame/Safari chrome ([#36](https://github.com/jbolabs/shouldertap/pull/36)).
- Do not add iOS UITest targets for copy/contrast ([#36](https://github.com/jbolabs/shouldertap/pull/36)).
- Do not bump Alchemy/Effect without migration doc ([#50](https://github.com/jbolabs/shouldertap/pull/50)).
- Do not mock internal modules (`vi.mock`) — repo has zero matches; keep it that way.

---

## Metrics to track after rollout

| Metric | Baseline (Oct 2026) |
| --- | --- |
| PRs whose primary purpose is deleting agent tests | 1 ([#36](https://github.com/jbolabs/shouldertap/pull/36)) |
| Safari/Frame fix-up PRs | 3 ([#5](https://github.com/jbolabs/shouldertap/pull/5), [#33](https://github.com/jbolabs/shouldertap/pull/33), [#51](https://github.com/jbolabs/shouldertap/pull/51)) |
| Infra fix-up PRs | 1 ([#44](https://github.com/jbolabs/shouldertap/pull/44)) |
| Org rename fix-ups | 1 ([#52](https://github.com/jbolabs/shouldertap/pull/52)) |
| Claude/Cursor co-authored commits | ~39–42 (`git log` count) |

Goal: **zero** PRs whose main diff is removing agent tests or fixing the same Frame/Safari mistake within 30 days of a codegen/CI guard landing.
