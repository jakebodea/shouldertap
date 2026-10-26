import { expect, test } from "@playwright/test";

const DOWNLOAD_PATH = /\/download$/u;
const DOWNLOAD_LABEL = /Download/u;
const RETRY_COPY = /If it didn’t/u;
const INSTALLER_PATH = /\/Shouldertap\.dmg$/u;
const WINDOWS_INSTALLER_PATH = /\/windows\/Shouldertap-Setup\.exe$/u;
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
// The landing page offers what the visitor's device can install; these run
// in iPhone-sized WebKit, so the desktop cases say they're a computer.
const APP_STORE_URL = "https://apps.apple.com/app/id6822383031";
const AS_COMPUTER = { hasTouch: false, isMobile: false } as const;

test.describe("on a Mac", () => {
  test.use({ ...AS_COMPUTER, userAgent: MAC_SAFARI });
  for (const placement of ["header", "footer"] as const) {
    test(`${placement} download starts before instructions and can be retried`, async ({
      page,
      context,
    }) => {
      await page.goto("/");
      const links = page.getByRole("link", { name: DOWNLOAD_LABEL });
      const link = placement === "header" ? links.first() : links.last();
      const started = page.waitForEvent("download");
      await link.click();
      await expect(page).toHaveURL(DOWNLOAD_PATH);
      const download = await started;
      expect(download.suggestedFilename()).toBe("Shouldertap.dmg");
      expect(await download.failure()).toBeNull();
      await expect(page.getByText(RETRY_COPY)).toBeVisible();
      expect(context.pages()).toHaveLength(1);

      const retried = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download for Mac" }).click();
      const retriedDownload = await retried;
      expect(await retriedDownload.failure()).toBeNull();
      await expect(page).toHaveURL(DOWNLOAD_PATH);
    });
  }
});

test.describe("on Windows", () => {
  test.use({ ...AS_COMPUTER, userAgent: WINDOWS_EDGE });
  test("the landing download is the Windows installer", async ({ page }) => {
    await page.goto("/");
    const started = page.waitForEvent("download");
    await page.getByRole("link", { name: DOWNLOAD_LABEL }).first().click();
    await expect(page).toHaveURL(DOWNLOAD_PATH);
    const download = await started;
    expect(download.suggestedFilename()).toBe("Shouldertap-Setup.exe");
    expect(await download.failure()).toBeNull();
  });
});

test("on an iPhone the landing page links the App Store, not an installer", async ({
  page,
}) => {
  await page.goto("/");
  const links = page.getByRole("link", { name: "Get the iPhone app" });
  await expect(links.last()).toHaveAttribute("href", APP_STORE_URL);
  await expect(page.getByRole("link", { name: DOWNLOAD_LABEL })).toHaveCount(0);
});

test("opening instructions directly offers a download without starting one", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/Shouldertap.dmg")) {
      requests.push(request.url());
    }
  });
  await page.goto("/download");
  await expect(
    page.getByRole("link", { name: "Download for Mac" })
  ).toHaveAttribute("href", INSTALLER_PATH);
  await expect(
    page.getByRole("link", { name: "Download for Windows" })
  ).toHaveAttribute("href", WINDOWS_INSTALLER_PATH);
  await expect(
    page.getByRole("link", { name: "Get the iPhone app" })
  ).toHaveAttribute("href", APP_STORE_URL);
  await expect(page.getByText(RETRY_COPY)).toHaveCount(0);
  expect(requests).toHaveLength(0);
});

test("a mistyped address leads back into the site", async ({ page }) => {
  await page.goto("/invite/old-link");
  await expect(
    page.getByRole("heading", { name: "There's nothing here" })
  ).toBeVisible();
  await page.getByRole("link", { name: "I have an invite link" }).click();
  await expect(page).toHaveURL(/\/join$/u);
});
