import { createRequire } from "node:module";
import path from "node:path";

import { messages, recipient, senders } from "./messages.mjs";

const here = import.meta.dirname;
const { chromium } = createRequire(
  path.join(here, "../../apps/web/package.json")
)("@playwright/test");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({
    // The window width the slides show, so the page lays itself out for it.
    viewport: { width: 700, height: 900 },
    deviceScaleFactor: 2,
  });
  await page.route("http://127.0.0.1:4318/**", async (route) => {
    const headers = {
      "access-control-allow-origin": "http://127.0.0.1:4319",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      status: route.request().method() === "POST" ? 201 : response.status(),
      headers: { ...response.headers(), ...headers },
    });
  });
  await page.goto("http://127.0.0.1:4319");
  await page.evaluate(() =>
    localStorage.setItem(
      "shouldertap.pairings.v2",
      JSON.stringify({
        pairings: [
          {
            token: "marketing.sender01.fictional00000001",
            credentialId: "sender01",
            recipientName: recipient,
            senderName: senders.dinner.name,
            color: senders.dinner.color,
          },
        ],
        selected: "sender01",
      })
    )
  );
  await page.goto("http://127.0.0.1:4319/tap");
  await page
    .getByText(messages.dinner, { exact: true })
    .waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(here, "captures/web-sender-dinner.png"),
  });
} finally {
  await browser.close();
}
