import path from "node:path";

import { expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";

export const server = () => {
  const value = process.env.SHOULDERTAP_SERVER_URL;
  if (!value) {
    throw new Error("Verification API URL is missing.");
  }
  return value;
};
export const web = () => {
  const value = process.env.SHOULDERTAP_WEB_URL;
  if (!value) {
    throw new Error("Verification web URL is missing.");
  }
  return value;
};

const CODE = /\b(?<code>\d{6})\b/u;
const INVITE_LINK = /^https?:\/\/\S+\/join[?#]/u;

/** Fetch outside Playwright: private mailbox bodies must not enter request artifacts. */
export const latestCode = async (email: string): Promise<string> => {
  const response = await fetch(
    `${server()}/__verify/mail?email=${encodeURIComponent(email)}`,
    {
      headers: {
        authorization: `Bearer ${process.env.SHOULDERTAP_VERIFY_TOKEN}`,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Verification mailbox returned HTTP ${response.status}.`);
  }
  const mail = (await response.json()) as { subject: string; text: string };
  const code = `${mail.subject}\n${mail.text}`.match(CODE)?.groups?.code;
  if (!code) {
    throw new Error("Verification email did not contain a six-digit code.");
  }
  return code;
};

/** Real UI email, OTP and profile flow. The returned bearer remains in memory only. */
export const signIn = async (
  page: Page,
  email: string,
  name: string,
  rejectWrongCode = false
) => {
  try {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send code", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email", exact: true })
    ).toBeVisible();
    const code = await latestCode(email);
    if (rejectWrongCode) {
      await page
        .getByLabel("Six-digit code")
        .fill(code === "000000" ? "111111" : "000000");
      await expect(page.getByRole("alert")).toHaveText(
        "That code didn't work. Check it or send a new one."
      );
      await expect(page.getByLabel("Six-digit code")).toHaveValue("");
    }
    const signedIn = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/sign-in/email-otp" &&
        response.ok()
    );
    await page.getByLabel("Six-digit code").fill(code);
    const signInResponse = await signedIn;
    const result = (await signInResponse.json()) as { token: string };
    if (typeof result.token !== "string" || result.token.length < 16) {
      throw new Error("Sign-in did not issue a session.");
    }
    await expect(
      page.getByRole("heading", { name: "Who's tapping?", exact: true })
    ).toBeVisible();
    await page.getByLabel("Your name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    return result.token;
  } catch {
    await page
      .locator("#code")
      .fill("")
      .catch(() => {
        // A closed page cannot retain visible credentials.
      });
    await page
      .evaluate(() => {
        history.replaceState(null, "", location.pathname);
      })
      .catch(() => {
        // A closed page cannot retain visible credentials.
      });
    throw new Error(
      "The real email/code/profile sign-in flow failed. Inspect the sanitized page state."
    );
  }
};

export const createInvite = async (page: Page) => {
  await page
    .getByRole("button", { name: "Invite someone", exact: true })
    .click();
  const link = page.getByText(INVITE_LINK);
  await expect(link).toBeVisible();
  const content = await link.textContent();
  const invite = content?.trim();
  if (!invite || new URL(invite).origin !== new URL(web()).origin) {
    throw new Error("The UI invite did not use this run's web origin.");
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  return invite;
};

export const acceptInvite = async (
  page: Page,
  invite: string,
  email: string,
  name: string
) => {
  if (new URL(invite).origin !== new URL(web()).origin) {
    throw new Error("Invite belongs to a different environment.");
  }
  try {
    await page.goto(invite);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await signIn(page, email, name);
    await expect(
      page.getByRole("heading", { name: /You and .+ are connected/u })
    ).toBeVisible();
    await page.getByRole("button", { name: /^Tap /u }).click();
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  } catch {
    await page
      .evaluate(() => {
        history.replaceState(null, "", location.pathname);
      })
      .catch(() => {
        // A closed page cannot retain visible credentials.
      });
    throw new Error("Accepting the invite through the UI failed.");
  }
};

export const sendTap = async (page: Page, body: string) => {
  await page.getByLabel("Message", { exact: true }).fill(body);
  const sent = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/taps" &&
      response.request().method() === "POST" &&
      response.ok()
  );
  await page.getByRole("button", { name: "Send tap", exact: true }).click();
  const sendResponse = await sent;
  const tap = (await sendResponse.json()) as {
    id: string;
    body: string;
    state: string;
  };
  expect(tap.body).toBe(body);
  expect(tap.state).toBe("pending");
  await expect(page.getByRole("article").filter({ hasText: body })).toHaveCount(
    1
  );
  return tap;
};

/** Call only on the composer after auth/invite fragments have left the URL. */
export const evidence = async (
  page: Page,
  testInfo: TestInfo,
  name: string
) => {
  await expect(page).toHaveURL(new URL("/tap", web()).href);
  const directory = process.env.SHOULDERTAP_VERIFY_ARTIFACTS;
  if (!directory) {
    throw new Error("Public verification evidence directory is missing.");
  }
  const image = await page.screenshot({
    path: path.join(directory, `${name}.png`),
  });
  await testInfo.attach(name, { body: image, contentType: "image/png" });
};
