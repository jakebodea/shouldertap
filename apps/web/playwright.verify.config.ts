import { defineConfig, devices } from "@playwright/test";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required; run the verification environment runner first.`
    );
  }
  return value;
};
const baseURL = required("SHOULDERTAP_WEB_URL");
const apiURL = required("SHOULDERTAP_SERVER_URL");
required("SHOULDERTAP_VERIFY_TOKEN");
for (const value of [baseURL, apiURL]) {
  const url = new URL(value);
  if (
    url.hostname === "shouldertap.app" ||
    url.hostname.endsWith(".shouldertap.app")
  ) {
    throw new Error(
      "Verification must use an isolated environment, never production."
    );
  }
}

export default defineConfig({
  testDir: "./e2e/verification",
  testMatch:
    process.env.SHOULDERTAP_VERIFY_NATIVE === "1"
      ? "native.spec.ts"
      : "browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: process.env.SHOULDERTAP_VERIFY_NATIVE === "1" ? 240_000 : 120_000,
  expect: { timeout: 20_000 },
  outputDir:
    process.env.SHOULDERTAP_VERIFY_OUTPUT ??
    "../../.verification/browser-output",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.SHOULDERTAP_VERIFY_REPORT ??
          "../../.verification/browser-report.json",
      },
    ],
  ],
  use: {
    ...devices["Desktop Safari"],
    baseURL,
    // Traces contain auth bodies, cookies, invite fragments and bearer keys.
    // Capture explicit screenshots after authentication instead.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
