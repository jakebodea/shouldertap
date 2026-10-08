import { expect, test } from "@playwright/test";

const DOWNLOAD_PATH = /\/download$/u;
const DOWNLOAD_LABEL = /Download/u;
const RETRY_COPY = /If it didn’t/u;
const INSTALLER_PATH = /\/Shouldertap\.dmg$/u;
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
  expect(requests).toHaveLength(0);
});
