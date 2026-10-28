import { expect, test } from "@playwright/test";
import { AccountClient, ApiClient } from "@shouldertap/client";

import {
  acceptInvite,
  createInvite,
  evidence,
  server,
  signIn,
  sendTap,
} from "./helpers";

/** This suite proves browser UI + real protocol, not native rendering or physical push. */
test("browser-protocol: fresh accounts, invite, send, display receipt and reply", async ({
  browser,
  page,
}, testInfo) => {
  const run = crypto.randomUUID();
  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  let invite: string;
  let receiver: ApiClient;
  try {
    await ownerPage.goto(`${process.env.SHOULDERTAP_WEB_URL}/tap`);
    const token = await signIn(
      ownerPage,
      `owner-${run}@example.test`,
      "Verification Recipient",
      true
    );
    await expect(
      ownerPage.getByRole("heading", { name: "Add your people", exact: true })
    ).toBeVisible();
    invite = await createInvite(ownerPage);
    const account = new AccountClient({
      baseUrl: server(),
      sessionToken: token,
    });
    const sync = await account.sync({
      platform: "mac",
      deviceName: "Protocol receiver",
      receive: true,
      tokens: [],
    });
    if (!sync.inbox) {
      throw new Error("Real account sync did not grant a receiver credential.");
    }
    receiver = new ApiClient({ baseUrl: server(), token: sync.inbox.token });
  } finally {
    // Owner UI may contain a secret invite on failure. Close before Playwright collects diagnostics.
    await owner.close();
  }
  await acceptInvite(
    page,
    invite,
    `sender-${run}@example.test`,
    "Verification Sender"
  );
  await expect(
    page.getByRole("heading", {
      name: "Tap Verification Recipient",
      exact: true,
    })
  ).toBeVisible();
  const tap = await sendTap(page, "Verification browser protocol tap");
  await expect
    .poll(async () => {
      const snapshot = await receiver.me();
      return snapshot.taps.find((item) => item.id === tap.id)?.body;
    })
    .toBe("Verification browser protocol tap");
  const displayed = await receiver.markDisplayed(tap.id);
  expect(displayed.state).toBe("pending");
  expect(displayed.displayedAt).toBeGreaterThan(0);
  const article = page
    .getByRole("article")
    .filter({ hasText: "Verification browser protocol tap" });
  await expect(
    article.getByText("On Verification Recipient's screen now", { exact: true })
  ).toBeAttached();
  await evidence(page, testInfo, "browser-protocol-displayed");
  const answered = await receiver.acknowledge(tap.id, {
    response: { kind: "text", text: "Verified protocol reply" },
  });
  expect(answered.response).toEqual({
    kind: "text",
    text: "Verified protocol reply",
  });
  await expect(
    article.getByText("Verified protocol reply", { exact: true })
  ).toBeVisible();
  await evidence(page, testInfo, "browser-protocol-reply");
  await page.reload();
  await expect(
    page
      .getByRole("article")
      .filter({ hasText: "Verification browser protocol tap" })
      .getByText("Verified protocol reply", { exact: true })
  ).toBeVisible();
});

test("account requests reject an unrelated browser origin", async () => {
  const response = await fetch(`${server()}/account/me`, {
    headers: { origin: "https://unrelated.example" },
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Origin not allowed" });
});
