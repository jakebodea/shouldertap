<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

## Tests

- Test behavior, not implementation. Call the code the way its users do and assert a literal expected value from an independent source (a worked example or the spec), never one recomputed the way the code computes it. Keep a test only if it would fail when every function it imports returned `undefined`: rewrite or delete tests whose only assertions are calls made (`toHaveBeenCalled*`), absence (`toBeUndefined`, `toEqual([])`), a restated constant, or data the test built itself.
- Fake only real system boundaries (external APIs, time, randomness, platform APIs) and pass them in; never mock the project's own modules. Freeze the clock in any test whose result depends on today's date.
- Prefer the tests that run the real thing: `apps/server` integration tests against a deployed preview and the Playwright download flows in `apps/web/e2e`.
