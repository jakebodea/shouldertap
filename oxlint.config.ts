import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, tanstack, vitest],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    // Generated: shadcn primitives, router tree, drizzle-kit output.
    "packages/ui/src/components/**",
    "apps/server/drizzle/**",
    "**/routeTree.gen.ts",
    // Not TypeScript: the Swift and Rust apps.
    "apps/macos/**",
    "apps/ios/**",
    "apps/windows/**",
    "lint/**",
  ],
  // Type-aware rules are off: oxlint's TypeScript-Go checker reads Effect generators
  // (`yield* new TaggedError(...)`) and Drizzle query results as `any`, which tsc does not.
  // `bun run check-types` stays the type gate, as it was under Biome.
  jsPlugins: [
    {
      name: "test-quality",
      specifier: "./lint/oxlint-plugin-test-quality.mjs",
    },
  ],
  rules: {
    // TypeScript rejects real redeclarations; this flags the Effect idiom of a schema and its type sharing a name.
    "no-redeclare": "off",
    // Effect modules co-locate a service with the tagged error classes it fails with.
    "max-classes-per-file": "off",
    // Package entry points re-export their modules.
    "oxc/no-barrel-file": "off",
  },
  overrides: [
    {
      // Alchemy convention: one PascalCase file per Resource (Worker, Durable Object).
      files: ["apps/server/src/**"],
      rules: {
        "unicorn/filename-case": [
          "error",
          { cases: { pascalCase: true, camelCase: true, kebabCase: true } },
        ],
      },
    },
    {
      files: ["**/*.test.{ts,tsx}"],
      plugins: ["vitest"],
      rules: {
        // @effect/vitest's `it.effect` and Alchemy's `Test.make` tests are test blocks.
        "vitest/no-standalone-expect": [
          "error",
          {
            additionalTestBlockFunctions: [
              "it.effect",
              "it.live",
              "it.scoped",
              "test",
            ],
          },
        ],
      },
    },
    {
      // The deployed end-to-end suite: each Alchemy `test` drives one whole protocol flow and
      // asserts every step, and the rule loses track of the Effect body passed to `test`.
      files: ["apps/server/test/integ.test.ts"],
      plugins: ["vitest"],
      rules: {
        "vitest/max-expects": "off",
        "vitest/no-standalone-expect": "off",
      },
    },
    {
      // Playwright specs: `test`/`expect` come from @playwright/test, which has no `.each`, and the
      // `.spec.ts` name keeps vitest from picking them up.
      files: ["apps/web/e2e/**"],
      plugins: ["vitest"],
      rules: {
        "vitest/consistent-test-filename": "off",
        "vitest/prefer-each": "off",
        "vitest/prefer-importing-vitest-globals": "off",
      },
    },
    {
      // A test must be able to fail when the code under test does nothing (AGENTS.md "Tests").
      files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
      rules: {
        // At least one assertion pins a produced value, not only absence, presence, or type.
        "test-quality/no-weak-only-assertions": "error",
        // Expected values are literals, not computed with the module under test.
        "test-quality/no-self-referential-expected": "error",
        // The test runs code instead of only reading constants or its own fixtures.
        "test-quality/require-subject-call": "error",
      },
    },
  ],
});
