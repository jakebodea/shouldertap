import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountAuth } from "../src/account-auth";
import { handleAccountHttp } from "../src/account-http";

const origin = "https://api.shouldertap.app";
const webOrigin = "https://shouldertap.app";
let db: DatabaseSync;
let sent: string[];
let subjects: string[];
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
    { auth, origin, webOrigin }
  );
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
/** A native app: no Origin, bearer session instead of cookies. */
const native = (path: string, body?: object, bearer?: string) =>
  handleAccountHttp(
    new Request(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { auth, origin, webOrigin }
  );
const emailedCode = () => sent.at(-1)?.match(/\b\d{6}\b/u)?.[0] ?? "";
const sendCode = (email = "reader@example.com") =>
  native("/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
/** A browser signed in with an emailed code: its session cookie. */
const signin = async () => {
  await sendCode();
  const signedIn = await request("/api/auth/sign-in/email-otp", {
    email: "reader@example.com",
    otp: emailedCode(),
  });
  if (signedIn.status !== 200) {
    throw new Error("Sign-in failed");
  }
  return {
    cookie: signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
};
/** A native app signed in with an emailed code: its session token. */
const nativeSession = async () => {
  await sendCode();
  const signedIn = await native("/api/auth/sign-in/email-otp", {
    email: "reader@example.com",
    otp: emailedCode(),
  });
  return ((await signedIn.json()) as { token: string }).token;
};
const showQr = async (bearer: string) => {
  const created = await native("/api/auth/qr-sign-in/create", {}, bearer);
  return (await created.json()) as {
    token: string;
    url: string;
    expiresAt: number;
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
    subjects = [];
    auth = createAccountAuth({
      database: db,
      secret: "local-test-only-secret-with-at-least-32-characters",
      origin,
      webOrigin,
      email: {
        send: (message) => {
          sent.push(message.text);
          subjects.push(message.subject);
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

  it("revokes the cookie session on sign out", async () => {
    const { cookie } = await signin();
    const signedOut = await request("/api/auth/sign-out", {}, cookie);
    const session = await json<{
      user: { email: string; emailVerified: boolean };
    }>("/api/auth/get-session", undefined, cookie);
    expect(signedOut.status).toBe(200);
    expect(session).toBeNull();
  });

  it("rejects foreign origins", async () => {
    const denied = await request(
      "/api/auth/email-otp/send-verification-otp",
      { email: "reader@example.com", type: "sign-in" },
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

  it("signs a native app in with the emailed six-digit code", async () => {
    const requested = await sendCode();
    const code = emailedCode();
    const signedIn = await native("/api/auth/sign-in/email-otp", {
      email: "Reader@Example.com",
      otp: code,
    });
    const { token } = (await signedIn.json()) as { token: string };
    const session = await native("/api/auth/get-session", undefined, token);
    expect(requested.status).toBe(200);
    expect(code).toMatch(/^\d{6}$/u);
    expect(signedIn.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      user: { email: "reader@example.com", emailVerified: true },
    });
  });

  it("puts the code in the email subject and stores only its hash", async () => {
    await sendCode();
    const code = emailedCode();
    const stored = db.prepare("SELECT value FROM verification").get() as {
      value: string;
    };
    expect(subjects.at(-1)).toBe(`${code} is your Shouldertap code`);
    expect(stored.value).not.toContain(code);
  });

  it("refuses a code after three wrong tries", async () => {
    await sendCode();
    const code = emailedCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- attempts must land in order
      await native("/api/auth/sign-in/email-otp", {
        email: "reader@example.com",
        otp: wrong,
      });
    }
    // Past the sign-in rate limit, so only the attempt count can refuse it.
    vi.setSystemTime(new Date("2026-10-21T12:01:30Z"));
    const late = await native("/api/auth/sign-in/email-otp", {
      email: "reader@example.com",
      otp: code,
    });
    expect(late.status).toBe(403);
  });

  it("expires a code after ten minutes", async () => {
    await sendCode();
    const code = emailedCode();
    vi.setSystemTime(new Date("2026-10-21T12:11:00Z"));
    const expired = await native("/api/auth/sign-in/email-otp", {
      email: "reader@example.com",
      otp: code,
    });
    expect(expired.status).toBe(400);
  });

  it("signs a phone in with a QR code from a signed-in computer", async () => {
    const mac = await nativeSession();
    const qr = await showQr(mac);
    const redeemed = await native("/api/auth/qr-sign-in/redeem", {
      token: new URL(qr.url).hash.slice(1),
      platform: "iphone",
    });
    const phone = (await redeemed.json()) as {
      token: string;
      user: { email: string };
    };
    const status = await native(
      "/api/auth/qr-sign-in/status",
      { token: qr.token },
      mac
    );
    await native("/api/auth/sign-out", {}, mac);
    const session = await native(
      "/api/auth/get-session",
      undefined,
      phone.token
    );
    expect(qr.url).toBe(`https://shouldertap.app/qr#${qr.token}`);
    expect(qr.expiresAt).toBe(Date.parse("2026-10-21T12:02:00Z"));
    expect(phone.user.email).toBe("reader@example.com");
    await expect(status.json()).resolves.toStrictEqual({
      status: "used",
      platform: "iphone",
    });
    await expect(session.json()).resolves.toMatchObject({
      user: { email: "reader@example.com" },
    });
  });

  it("signs a browser in with a QR code and sets its cookie", async () => {
    const qr = await showQr(await nativeSession());
    const redeemed = await request("/api/auth/qr-sign-in/redeem", {
      token: qr.token,
      platform: "web",
    });
    const cookie = redeemed.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const session = await json<{ user: { email: string } }>(
      "/api/auth/get-session",
      undefined,
      cookie
    );
    expect(session.user.email).toBe("reader@example.com");
  });

  it("accepts a sign-in QR code only once", async () => {
    const qr = await showQr(await nativeSession());
    const first = await native("/api/auth/qr-sign-in/redeem", {
      token: qr.token,
    });
    const replay = await native("/api/auth/qr-sign-in/redeem", {
      token: qr.token,
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(400);
  });

  it("expires a sign-in QR code after two minutes", async () => {
    const mac = await nativeSession();
    const qr = await showQr(mac);
    vi.setSystemTime(new Date("2026-10-21T12:02:01Z"));
    const status = await native(
      "/api/auth/qr-sign-in/status",
      { token: qr.token },
      mac
    );
    const late = await native("/api/auth/qr-sign-in/redeem", {
      token: qr.token,
    });
    await expect(status.json()).resolves.toStrictEqual({
      status: "expired",
      platform: null,
    });
    expect(late.status).toBe(400);
  });

  it("shows a pending QR code only to the account that made it", async () => {
    const mac = await nativeSession();
    const qr = await showQr(mac);
    const pending = await native(
      "/api/auth/qr-sign-in/status",
      { token: qr.token },
      mac
    );
    await sendCode("other@example.com");
    const other = await native("/api/auth/sign-in/email-otp", {
      email: "other@example.com",
      otp: emailedCode(),
    });
    const { token: otherToken } = (await other.json()) as { token: string };
    const snooped = await native(
      "/api/auth/qr-sign-in/status",
      { token: qr.token },
      otherToken
    );
    await expect(pending.json()).resolves.toStrictEqual({
      status: "pending",
      platform: null,
    });
    await expect(snooped.json()).resolves.toStrictEqual({
      status: "expired",
      platform: null,
    });
  });

  it("makes sign-in QR codes only for a signed-in account", async () => {
    const created = await native("/api/auth/qr-sign-in/create", {});
    expect(created.status).toBe(401);
  });

  it("stores only the hash of a sign-in QR code", async () => {
    const qr = await showQr(await nativeSession());
    const rows = db
      .prepare(
        "SELECT identifier FROM verification WHERE identifier LIKE 'qr-%'"
      )
      .all() as { identifier: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toMatch(/^qr-sign-in:[\w-]{43}$/u);
    expect(rows[0]?.identifier).not.toContain(qr.token);
  });

  it("signs a computer in when a signed-in phone approves its QR code", async () => {
    const phone = await nativeSession();
    const code = await json<{
      device_code: string;
      verification_uri_complete: string;
    }>("/api/auth/device/code", { client_id: "shouldertap-mac" });
    const scanned = new URL(code.verification_uri_complete);
    const userCode = scanned.searchParams.get("user_code") ?? "";
    const review = await native(
      `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      undefined,
      phone
    );
    await native("/api/auth/device/approve", { userCode }, phone);
    const mac = await json("/api/auth/device/token", {
      client_id: "shouldertap-mac",
      device_code: code.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const session = await native(
      "/api/auth/get-session",
      undefined,
      mac.access_token
    );
    expect(scanned.origin + scanned.pathname).toBe(
      "https://shouldertap.app/account/device"
    );
    await expect(review.json()).resolves.toMatchObject({
      client_id: "shouldertap-mac",
      status: "pending",
    });
    await expect(session.json()).resolves.toMatchObject({
      user: { email: "reader@example.com" },
    });
  });
});
