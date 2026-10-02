import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "iphone-webkit",
      use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" },
    },
  ],
  webServer: [
    {
      command: "bun run build && bun run serve --host 127.0.0.1 --port 4173",
      env: {
        VITE_MAC_DOWNLOAD_URL: "http://127.0.0.1:4174/Shouldertap.dmg",
      },
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "bun e2e/download-server.ts",
      url: "http://127.0.0.1:4174/health",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
