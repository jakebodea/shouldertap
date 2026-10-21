import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountAuth } from "../src/account-auth";
import { handleAccountHttp } from "../src/account-http";
import { accountPage } from "../src/account-page";

const origin = "https://api.shouldertap.app";
const webOrigin = "https://shouldertap.app";
let db: DatabaseSync;
let sent: string[];
let auth: ReturnType<typeof createAccountAuth>;
const request = (path: string, body?: object, cookie?: string, from = origin) =>
  handleAccountHttp(
    new Request(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin: from,
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { auth, origin, webOrigin, page: accountPage }
  );
const emailedToken = () => {
  const message = sent.at(-1);
  if (!message) {
    throw new Error("Expected a sign-in email");
  }
  const link = message.split("\n").find((line) => line.startsWith(origin));
  if (!link) {
    throw new Error("Expected a confirmation link");
  }
  return decodeURIComponent(new URL(link).hash.slice(1));
};
const signin = async () => {
  const response = await request("/api/auth/sign-in/magic-link", {
    email: "reader@example.com",
    callbackURL: "/account",
  });
  if (response.status !== 200) {
    throw new Error("Sign-in email was rejected");
  }
  const token = emailedToken();
  const verified = await request("/account/verify", { token });
  if (verified.status !== 204) {
    throw new Error("Sign-in verification failed");
  }
  return {
    token,
    cookie: verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
};
const json = async <
  T = { error: string; client_id: string; access_token: string },
>(
  path: string,
  body?: object,
  cookie?: string
): Promise<T> => {
  const response = await request(path, body, cookie);
  return response.json() as Promise<T>;
};
const issueDevice = async () => {
  const grant = await json<{ device_code: string; user_code: string }>(
    "/api/auth/device/code",
    {
      client_id: "shouldertap-ios",
    }
  );
  return {
    grant,
    payload: {
      client_id: "shouldertap-ios",
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  };
};
describe("email account HTTP flow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    db = new DatabaseSync(":memory:");
    db.exec(
      readFileSync(
        fileURLToPath(
          new URL("../account-migrations/0001_auth.sql", import.meta.url)
        ),
        "utf-8"
      )
    );
    sent = [];
    auth = createAccountAuth({
      database: db,
      secret: "local-test-only-secret-with-at-least-32-characters",
      origin,
      webOrigin,
      email: {
        send: (message) => {
          sent.push(message.text);
          return Promise.resolve({ messageId: "example" });
        },
      },
    });
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("signs in with verified email", async () => {
    const { cookie } = await signin();
    const session = await json<{
      user: { email: string; emailVerified: boolean };
    }>("/api/auth/get-session", undefined, cookie);
    expect(cookie).toContain("__Secure-better-auth.session_token=");
    expect(session.user).toMatchObject({
      email: "reader@example.com",
      emailVerified: true,
    });
  });

  it("consumes a magic link only once", async () => {
    const { token } = await signin();
    const replay = await request("/account/verify", { token });
    expect(replay.status).toBe(400);
  });

  it("revokes the cookie session on sign out", async () => {
    const { cookie } = await signin();
    const signedOut = await request("/api/auth/sign-out", {}, cookie);
    const session = await json<{
      user: { email: string; emailVerified: boolean };
    }>("/api/auth/get-session", undefined, cookie);
    expect(signedOut.status).toBe(200);
    expect(session).toBeNull();
  });

  it("expires links after ten minutes and stores no raw token", async () => {
    const issued = await request("/api/auth/sign-in/magic-link", {
      email: "reader@example.com",
    });
    const token = emailedToken();
    const stored = db.prepare("SELECT identifier FROM verification").get() as {
      identifier: string;
    };
    vi.setSystemTime(new Date("2026-10-21T12:11:00Z"));
    const expired = await request("/account/verify", { token });
    expect(issued.status).toBe(200);
    expect(stored.identifier).toMatch(/^magic-link:/u);
    expect(stored.identifier).not.toContain(token);
    expect(expired.status).toBe(400);
  });

  it("rejects foreign origins", async () => {
    const denied = await request(
      "/api/auth/sign-in/magic-link",
      { email: "reader@example.com" },
      undefined,
      "https://evil.example"
    );
    expect(denied.status).toBe(403);
  });

  it("scopes cookie CORS", async () => {
    const allowed = await request(
      "/api/auth/get-session",
      undefined,
      undefined,
      webOrigin
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe(webOrigin);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
  });

  it("requires explicit confirmation instead of redeeming links from URLs", async () => {
    const page = await request("/account");
    const content = await page.text();
    const verification = await request(
      "/api/auth/magic-link/verify?token=example"
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    expect(content).toContain("Confirm sign in");
    expect(verification.status).toBe(405);
  });

  it("issues a native session only after explicit device approval", async () => {
    const { cookie } = await signin();
    const { grant, payload } = await issueDevice();
    const pending = await json("/api/auth/device/token", payload);
    const review = await json(
      `/api/auth/device?user_code=${encodeURIComponent(grant.user_code)}`,
      undefined,
      cookie
    );
    const approved = await request(
      "/api/auth/device/approve",
      { userCode: grant.user_code },
      cookie
    );
    vi.setSystemTime(new Date("2026-10-21T12:00:06Z"));
    const result = await json("/api/auth/device/token", payload);
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${result.access_token}` }),
    });
    expect(pending.error).toBe("authorization_pending");
    expect(review.client_id).toBe("shouldertap-ios");
    expect(approved.status).toBe(200);
    expect(session?.user.email).toBe("reader@example.com");
  });

  it("denies a native grant after the user declines", async () => {
    const { cookie } = await signin();
    const { grant, payload } = await issueDevice();
    await request(
      `/api/auth/device?user_code=${encodeURIComponent(grant.user_code)}`,
      undefined,
      cookie
    );
    const denied = await request(
      "/api/auth/device/deny",
      { userCode: grant.user_code },
      cookie
    );
    const result = await json("/api/auth/device/token", payload);
    expect(denied.status).toBe(200);
    expect(result.error).toBe("access_denied");
  });

  it("expires an unapproved native grant", async () => {
    const { payload } = await issueDevice();
    vi.setSystemTime(new Date("2026-10-21T12:11:00Z"));
    const result = await json("/api/auth/device/token", payload);
    expect(result.error).toBe("expired_token");
  });

  it("consumes an approved native grant only once", async () => {
    const { cookie } = await signin();
    const { grant, payload } = await issueDevice();
    await request(
      `/api/auth/device?user_code=${encodeURIComponent(grant.user_code)}`,
      undefined,
      cookie
    );
    await request(
      "/api/auth/device/approve",
      { userCode: grant.user_code },
      cookie
    );
    const first = await json("/api/auth/device/token", payload);
    vi.setSystemTime(new Date("2026-10-21T12:00:06Z"));
    const replay = await json("/api/auth/device/token", payload);
    expect(first.access_token).toStrictEqual(expect.any(String));
    expect(replay.error).toBe("invalid_grant");
  });
});
