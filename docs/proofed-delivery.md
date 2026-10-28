# Proofed delivery

A proof bundle ties a committed change to executed checks, visible evidence, independent review and a verdict. It follows the PStack delivery principles while using this repository's scripts and [verification environments](verification.md). A receipt is an integrity record, not a guarantee that unexecuted platforms work.

## Before creating proof

```sh
bun install --frozen-lockfile
bun run proof -- doctor
bun run verify:doctor
```

`proof doctor` checks Git/GitHub authentication and media-attachment support. It does not deploy or exercise the app. `proof run` requires a clean committed tree, changed files relative to the base, and a branch containing the current base. Fetch/update `origin/main` before proof; the tool checks local refs and does not silently fetch or modify the branch. Uncommitted work cannot have valid committed proof.

## Capture and verify

```sh
bun run proof -- run --base origin/main --flow "Describe the user-visible journey"
```

The tool classifies changed paths and runs canonical gates:

- Low risk: `bun run ci`.
- Medium risk: CI, `bun run build`, then the real browser/protocol verification journey.
- High/critical risk: CI, build and `bun run verify -- --local --scenario core`.

Risk can be raised with `--risk`; it cannot be lowered below the automatic tier. Native/protocol/server changes are high risk; infrastructure, auth, verification and workflow changes are critical. High/critical proof needs a real independent verifier result. Critical proof also needs a rollback plan and a captured focused boundary check. Visible UI changes require image/video evidence imported from the executed runtime receipt. The proof bundle automatically copies that receipt and verifies every artifact hash; unrelated or older screenshots cannot satisfy the gate.

Pass those inputs with repeatable flags:

```text
--flow "Journey and expected result"
--artifact "/path/to/current-runtime-screenshot.png#What this image demonstrates"
--focused-check "boundary::command that actually checks the boundary"
--verifier-verdict PASS
--verifier-summary "What the independent reviewer checked and any limits"
--verifier-source "Actual review source or thread identifier"
--rollback "Concrete revert/recovery steps"
--note "A remaining limitation"
```

`--artifact` is optional and only accepts media already recorded by the current runtime receipt. The runner automatically imports its screenshots.

Only use an independent review that actually happened. A flow label, note, or reviewer assertion does not run a test. Focused commands execute through the shell; never put credentials in their command text or printed output. Core needs the shared-device launcher configuration documented in verification.md.

The command prints the verdict and receipt path under `.artifacts/proofs/`. Keep the receipt, generated report, hashed command logs and copied artifacts together. Then run:

```sh
bun run proof -- verify --receipt /absolute/path/to/receipt.json
```

Verification checks head/base identities, stable patch ID, changed files, minimum risk, required gates, command status, log/artifact digests and generated report. A new commit or changed base requires fresh proof. `FAIL` means an executed check failed; `BLOCKED` means required proof is missing; `PASS_WITH_NOTES` retains stated limitations. None of these statuses establishes production deployment or physical APNs delivery.

## Share the reviewed result

When publishing proof to a PR is explicitly requested:

```sh
bun run proof -- publish --pr <number-or-url> --receipt /absolute/path/to/receipt.json
```

This verifies the bundle again, checks the current PR head/base, then posts a proof comment with media attachments. It refuses failed/blocked proof and duplicate publication for the same head. Review logs/artifacts for sensitive content before sharing; never attach the private `.verification/` directory. Publishing does not open, merge or deploy the PR.

## Relationship to CI and release

CI's `verification` aggregate covers its executed hosted/browser/native checks. The local proof command additionally enforces risk-sensitive evidence and core runtime checks. CI does not automatically publish a PStack proof bundle or attest that a named independent reviewer ran anything. Both evidence paths must describe their actual coverage.

The repository configures `verification` as the required branch-protection check, and release validates that exact source's successful aggregate. Live GitHub protection, hosted test-account setup and successful hosted runs must be verified separately; changing configuration files does not apply them. Physical iPhone notifications/Live Activities, real billing sandbox checkout and Windows desktop behavior remain explicit release gates.
