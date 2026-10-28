import { readFile, rename, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { acceptInvite, evidence, sendTap } from "./helpers";

/** No protocol display/ack calls here: only the running native app can advance the tap. */
test("native foreground: web sender sees the real app display and reply", async ({
  page,
}, testInfo) => {
  const exchange = process.env.SHOULDERTAP_VERIFY_EXCHANGE;
  if (!exchange) {
    throw new Error(
      "Native verification requires a private exchange file from the native runner."
    );
  }
  let invite: string;
  try {
    const value = JSON.parse(await readFile(exchange, "utf-8")) as {
      invite?: unknown;
    };
    if (typeof value.invite !== "string") {
      throw new TypeError("Missing invite.");
    }
    ({ invite } = value);
  } catch {
    throw new Error(
      "Native runner did not supply a valid private invite exchange."
    );
  }
  await acceptInvite(
    page,
    invite,
    `native-sender-${crypto.randomUUID()}@example.test`,
    "Verification Web Sender"
  );
  const tap = await sendTap(page, "Verification native foreground tap");
  const temporary = `${exchange}.sent.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ tapId: tap.id, body: tap.body }),
    { mode: 0o600 }
  );
  await rename(temporary, `${exchange}.sent.json`);
  const article = page
    .getByRole("article")
    .filter({ hasText: "Verification native foreground tap" });
  await expect(article.getByText(/^On .+'s screen now$/u)).toBeAttached({
    timeout: 60_000,
  });
  await evidence(page, testInfo, "native-app-displayed");
  const ready = `${exchange}.displayed.tmp`;
  await writeFile(ready, JSON.stringify({ tapId: tap.id }), { mode: 0o600 });
  await rename(ready, `${exchange}.displayed.json`);
  await expect(article.getByText("On it", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await evidence(page, testInfo, "native-app-replied");
});
