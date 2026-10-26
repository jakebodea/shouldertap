import { describe, expect, it } from "vitest";

import { AccountClient, deviceSignInCode, qrSignInToken } from "./account";

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * A stand-in for the API origin (the network is the boundary): one emailed
 * code, and a session that a browser carries as a cookie and a native app
 * as a bearer token. Like a browser, it fails a cookie-carrying request to
 * `/v1/`, whose CORS policy is `*` without credentials.
 */
const fakeServer = () => {
  let code: string | null = null;
  let cookie = false;
  const me = {
    email: "sam@example.com",
    profile: null,
    sendProfile: null,
    suggestedName: "Sam",
    inboxId: null,
  };
  const respond = (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body: Record<string, unknown> = init.body
      ? JSON.parse(String(init.body))
      : {};
    const headers = new Headers(init.headers);
    const signedIn =
      (init.credentials === "include" && cookie) ||
      headers.get("Authorization") === "Bearer native-session";
    switch (url.pathname) {
      case "/api/auth/email-otp/send-verification-otp": {
        code = body.type === "sign-in" ? "123456" : null;
        return json(200, { success: true });
      }
      case "/api/auth/sign-in/email-otp": {
        if (body.email !== me.email || body.otp !== code) {
          return json(400, { code: "INVALID_OTP", message: "Invalid OTP" });
        }
        cookie = init.credentials === "include";
        return json(200, {
          token: "native-session",
          user: { email: me.email },
        });
      }
      case "/account/me": {
        return signedIn ? json(200, me) : json(401, { error: "Sign in" });
      }
      case "/account/accept": {
        return json(400, { error: "That's your own invite" });
      }
      case "/account/sync": {
        return json(200, {
          me,
          inbox: null,
          senders: [],
          removed: body.tokens,
        });
      }
      case "/v1/invites/preview": {
        return url.searchParams.get("code") === "in/1#a"
          ? json(200, { name: "Ana", color: "plum", expiresAt: 99 })
          : json(404, { error: "That invite isn't valid" });
      }
      default: {
        return json(404, { error: "Not found" });
      }
    }
  };
  const fetch = (input: string, init: RequestInit) =>
    new URL(input).pathname.startsWith("/v1/") && init.credentials === "include"
      ? Promise.reject(new TypeError("Load failed"))
      : Promise.resolve(respond(input, init));
  return { fetch };
};

describe("signing in from the browser", () => {
  it("has no session until the emailed code is entered", async () => {
    const { fetch } = fakeServer();
    const client = new AccountClient({ baseUrl: "https://api.test/", fetch });

    await expect(client.session()).resolves.toBeNull();
    await client.sendCode("sam@example.com");
    await expect(client.signIn("sam@example.com", "000000")).rejects.toThrow(
      "Invalid OTP"
    );
    await client.signIn("sam@example.com", "123456");

    await expect(client.session()).resolves.toStrictEqual({
      email: "sam@example.com",
      profile: null,
      sendProfile: null,
      suggestedName: "Sam",
      inboxId: null,
    });
  });

  it("reports a wrong code as a bad request", async () => {
    const { fetch } = fakeServer();
    const client = new AccountClient({ baseUrl: "https://api.test", fetch });
    await client.sendCode("sam@example.com");
    await expect(
      client.signIn("sam@example.com", "999999")
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });
});

describe("native session", () => {
  it("authenticates with the session token as a bearer", async () => {
    const { fetch } = fakeServer();
    const native = new AccountClient({
      baseUrl: "https://api.test",
      sessionToken: "native-session",
      fetch,
    });
    await expect(native.me()).resolves.toMatchObject({
      email: "sam@example.com",
    });
  });
});

describe("account errors", () => {
  it("shows the server's own wording", async () => {
    const { fetch } = fakeServer();
    const client = new AccountClient({ baseUrl: "https://api.test", fetch });
    await expect(
      client.accept({ code: "mine", platform: "web", deviceName: "Safari" })
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "That's your own invite",
    });
  });

  it("tells a dropped connection apart from a refusal", async () => {
    const client = new AccountClient({
      baseUrl: "https://api.test",
      fetch: () => Promise.reject(new TypeError("Load failed")),
    });
    await expect(client.me()).rejects.toMatchObject({
      code: "network",
      status: 0,
    });
  });
});

describe("invites", () => {
  it("looks up an invite whose code needs escaping", async () => {
    const { fetch } = fakeServer();
    const client = new AccountClient({ baseUrl: "https://api.test", fetch });
    await expect(client.previewInvite("in/1#a")).resolves.toStrictEqual({
      name: "Ana",
      color: "plum",
      expiresAt: 99,
    });
  });
});

describe("sync", () => {
  it("sends at most fifty tokens", async () => {
    const { fetch } = fakeServer();
    const client = new AccountClient({ baseUrl: "https://api.test", fetch });
    const tokens = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const result = await client.sync({
      platform: "web",
      deviceName: "Safari on iPhone",
      receive: false,
      tokens,
    });
    expect(result.removed).toHaveLength(50);
    expect(result.removed.at(-1)).toBe("t49");
  });
});

describe("sign-in QR codes", () => {
  it("reads the token from a scanned computer QR code", () => {
    expect(
      qrSignInToken(
        "https://shouldertap.app/qr#Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"
      )
    ).toBe("Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56");
    expect(qrSignInToken("shouldertap://qr#Ab12Cd34Ef56Gh78")).toBe(
      "Ab12Cd34Ef56Gh78"
    );
    expect(qrSignInToken("https://shouldertap.app/join#in/1#a")).toBeNull();
  });

  it("reads the code from a scanned device sign-in QR code", () => {
    expect(
      deviceSignInCode(
        "https://api.shouldertap.app/account/device?user_code=ABCD1234"
      )
    ).toBe("ABCD1234");
    expect(
      deviceSignInCode("http://api.shouldertap.app/account/device?user_code=X")
    ).toBeNull();
  });

  it("keeps polling a device sign-in, slower when asked", async () => {
    const replies = [
      json(400, { error: "authorization_pending" }),
      json(400, { error: "slow_down" }),
      json(200, { access_token: "mac-session" }),
    ];
    const client = new AccountClient({
      baseUrl: "https://api.example",
      fetch: () => Promise.resolve(replies.shift() ?? json(500, {})),
    });
    const started = {
      deviceCode: "device",
      userCode: "ABCD1234",
      url: "https://api.example/account/device?user_code=ABCD1234",
      interval: 5,
      expiresAt: 0,
    };
    const polls = [
      await client.pollDeviceSignIn("shouldertap-mac", started),
      await client.pollDeviceSignIn("shouldertap-mac", started),
      await client.pollDeviceSignIn("shouldertap-mac", started, 10),
    ];
    expect(polls).toStrictEqual([
      { kind: "pending", interval: 5 },
      { kind: "pending", interval: 10 },
      { kind: "signed-in", token: "mac-session" },
    ]);
  });
});
