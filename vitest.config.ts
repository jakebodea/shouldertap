import { defineConfig } from "vitest/config";

// Root-level stacks, scripts and lint rules only; each workspace package runs its own tests through turbo.
export default defineConfig({
  test: {
    include: [
      "scripts/**/*.test.ts",
      "lint/**/*.test.ts",
      "stacks/**/*.test.ts",
      "!scripts/**/node_modules/**",
    ],
  },
});
