import { defineConfig } from "vitest/config";

// Unit tests for plain modules only; the browser flows live in e2e (Playwright).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
