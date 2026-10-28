import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountAuth } from "../src/account-auth";
import { handleAccountHttp } from "../src/account-http";
import {
  captureAccountEmail,
  isVerificationStage,
  verificationMailResponse,
} from "../src/verification-mail";

const token = "verification-run-private-token-32-characters";
const origin = "https://api-verify.example.com";
const webOrigin = "https://web-verify.example.com";
let sqlite: DatabaseSync;
let database: D1Database;
const mailbox = (method = "GET", authorization = `Bearer ${token}`) =>
  verificationMailResponse(
    new Request(`${origin}/__verify/mail?email=reader%40example.com`, {
      method,
      headers: { authorization },
    }),
    { database, token }
  );
const deliver = () =>
  captureAccountEmail(database).send({
    from: { email: "signin@example.com", name: "Shouldertap" },
    to: "Reader@Example.com",
    replyTo: "support@example.com",
    subject: "482913 is your Shouldertap code",
    text: "Your code is 482913",
    html: "482913",
  });

describe("verification email boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    for (const migration of [
      "../account-migrations/0001_auth.sql",
      "../src/verification-migrations/0001_mail.sql",
    ]) {
      sqlite.exec(readFileSync(new URL(migration, import.meta.url), "utf-8"));
    }
    // Adapt only D1 transport; SQLite executes the production queries.
    database = {
      prepare: (sql: string) => ({
        bind: (...args: never[]) => ({
          first: () =>
            Promise.resolve(sqlite.prepare(sql).get(...args) ?? null),
          run: () => Promise.resolve(sqlite.prepare(sql).run(...args)),
        }),
      }),
    } as unknown as D1Database;
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  it("signs in through real auth using captured email from the configured web origin", async () => {
    const auth = createAccountAuth({
      database: sqlite,
      secret: "verification-auth-secret-more-than-32-characters",
      origin,
      webOrigin,
      email: captureAccountEmail(database),
    });
    const request = (path: string, body: object, from = webOrigin) =>
      handleAccountHttp(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: { origin: from, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { auth, origin, webOrigin }
      );
    const sent = await request("/api/auth/email-otp/send-verification-otp", {
      email: "reader@example.com",
      type: "sign-in",
    });
    expect(sent.status).toBe(200);
    const captured = await mailbox();
    const email = (await captured.json()) as { subject: string; text: string };
    const code = email.subject.match(/^\d{6}/u)?.[0];
    const signedIn = await request("/api/auth/sign-in/email-otp", {
      email: "reader@example.com",
      otp: code,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("access-control-allow-origin")).toBe(webOrigin);
    const session = (await signedIn.json()) as {
      user: { emailVerified: boolean; email: string };
    };
    expect(session.user).toMatchObject({
      emailVerified: true,
      email: "reader@example.com",
    });
    const foreign = await request(
      "/api/auth/email-otp/send-verification-otp",
      { email: "reader@example.com", type: "sign-in" },
      "https://another-preview.example.com"
    );
    expect(foreign.status).toBe(403);
  });

  it("keeps codes private and clears the current mailbox", async () => {
    await deliver();
    const denied = await mailbox("GET", "Bearer another-run-token");
    expect({ status: denied.status, body: await denied.text() }).toStrictEqual({
      status: 404,
      body: '{"error":"Not found"}',
    });
    const received = await mailbox();
    expect(received.headers.get("cache-control")).toBe("no-store");
    await expect(received.json()).resolves.toStrictEqual({
      to: "reader@example.com",
      subject: "482913 is your Shouldertap code",
      text: "Your code is 482913",
    });
    const cleared = await mailbox("DELETE");
    await expect(cleared.json()).resolves.toStrictEqual({ cleared: true });
    const missing = await mailbox();
    expect(missing.status).toBe(404);
  });

  it("does not return expired sign-in emails", async () => {
    await deliver();
    const received = await mailbox();
    expect(received.status).toBe(200);
    vi.setSystemTime(new Date("2026-10-27T12:11:00Z"));
    const missing = await mailbox();
    expect(missing.status).toBe(404);
  });

  it("allocates capture only for explicitly named verification stages", () => {
    expect(isVerificationStage("verify-loyw3v28-012345abcdef")).toBeTruthy();
    expect(isVerificationStage("prod")).toBeFalsy();
    expect(isVerificationStage("dev")).toBeFalsy();
    expect(isVerificationStage("pr-15")).toBeFalsy();
    expect(isVerificationStage("verify-../prod")).toBeFalsy();
  });
});
