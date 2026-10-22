import { AccountClient } from "@shouldertap/client";
import type { DeviceSignIn, QrSignIn } from "@shouldertap/client";
import { describe, expect, it } from "vitest";

import {
  afterDevicePoll,
  afterQrStatus,
  afterQrStatusFailed,
  appLink,
  qrTokenFromFragment,
  signedInOn,
  tradeBearerForCookie,
} from "./qr-sign-in";

const TOKEN = "Abc123Def456Ghi789Jkl012Mno345Pq";

describe("the /qr page's fragment", () => {
  it("reads the sign-in token after the #", () => {
    expect(qrTokenFromFragment(`#${TOKEN}`)).toBe(TOKEN);
  });

  it("refuses anything that isn't a sign-in token", () => {
    expect(qrTokenFromFragment("")).toBeNull();
    expect(qrTokenFromFragment("#short")).toBeNull();
    expect(qrTokenFromFragment(`#${TOKEN}/../x`)).toBeNull();
    expect(qrTokenFromFragment(`#${TOKEN}#again`)).toBeNull();
  });

  it("hands the same code to the iPhone app", () => {
    expect(appLink(TOKEN)).toBe(
      "shouldertap://qr#Abc123Def456Ghi789Jkl012Mno345Pq"
    );
  });
});

describe("who scanned the code", () => {
  it("names the kind of device", () => {
    expect(signedInOn("iphone")).toBe("Signed in on your iPhone");
    expect(signedInOn("windows")).toBe("Signed in on your PC");
    expect(signedInOn(null)).toBe("Signed in on your phone");
  });
});

const qr: QrSignIn = {
  token: TOKEN,
  url: `https://shouldertap.app/qr#${TOKEN}`,
  expiresAt: 1_000_000,
};
const showing = { kind: "showing", qr } as const;

describe("a sign-in code shown to a phone", () => {
  it("stays up while it waits", () => {
    expect(afterQrStatus(showing, { status: "pending", platform: null })).toBe(
      showing
    );
  });

  it("says where it was used", () => {
    expect(
      afterQrStatus(showing, { status: "used", platform: "iphone" })
    ).toStrictEqual({ kind: "used", platform: "iphone" });
  });

  it("offers a new one once it expires", () => {
    expect(
      afterQrStatus(showing, { status: "expired", platform: null })
    ).toStrictEqual({ kind: "expired" });
  });

  it("rides out a failed check until its two minutes are up", () => {
    expect(afterQrStatusFailed(showing, 999_999)).toBe(showing);
    expect(afterQrStatusFailed(showing, 1_000_000)).toStrictEqual({
      kind: "expired",
    });
  });
});

const started: DeviceSignIn = {
  deviceCode: "device-code",
  userCode: "WDJBMJHT",
  url: "https://api.shouldertap.app/account/device?user_code=WDJBMJHT",
  interval: 5,
  expiresAt: 2_000_000,
};
const waiting = { kind: "waiting", started, interval: 5 } as const;

describe("waiting for a phone to approve this browser", () => {
  it("polls at the pace the server asks for", () => {
    expect(
      afterDevicePoll(waiting, { kind: "pending", interval: 10 }, 1_000_000)
    ).toStrictEqual({ kind: "waiting", started, interval: 10 });
  });

  it("gives up once the code has expired, even if the server hasn't said", () => {
    expect(
      afterDevicePoll(waiting, { kind: "pending", interval: 5 }, 2_000_000)
    ).toStrictEqual({ kind: "expired" });
  });

  it("signs in with the approved session", () => {
    expect(
      afterDevicePoll(
        waiting,
        { kind: "signed-in", token: "phone-approved" },
        1_000_000
      )
    ).toStrictEqual({ kind: "signing-in", token: "phone-approved" });
  });

  it("says so when the phone says no", () => {
    expect(
      afterDevicePoll(waiting, { kind: "denied" }, 1_000_000)
    ).toStrictEqual({
      kind: "denied",
    });
  });
});

/**
 * A stand-in for the API origin (the network is the boundary): sessions by
 * token, a browser cookie, and one-time QR sign-in codes.
 */
const fakeServer = () => {
  const sessions = new Set(["phone-approved"]);
  const codes = new Set<string>();
  let cookie: string | null = null;
  let next = 0;
  const fetch = (input: string, init: RequestInit) => {
    const { pathname } = new URL(input);
    const body: Record<string, unknown> = init.body
      ? JSON.parse(String(init.body))
      : {};
    const bearer = new Headers(init.headers)
      .get("Authorization")
      ?.replace("Bearer ", "");
    const session = init.credentials === "include" ? cookie : (bearer ?? null);
    const live = session !== null && sessions.has(session);
    switch (pathname) {
      case "/api/auth/qr-sign-in/create": {
        if (!live) {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        next += 1;
        codes.add(`qr-${next}`);
        return Promise.resolve(Response.json({ token: `qr-${next}` }));
      }
      case "/api/auth/qr-sign-in/redeem": {
        if (!codes.delete(String(body.token))) {
          return Promise.resolve(Response.json({}, { status: 400 }));
        }
        next += 1;
        const made = `session-${next}`;
        sessions.add(made);
        if (init.credentials === "include") {
          cookie = made;
        }
        return Promise.resolve(
          Response.json({ token: made, user: { email: "sam@example.com" } })
        );
      }
      case "/api/auth/sign-out": {
        if (session) {
          sessions.delete(session);
        }
        return Promise.resolve(Response.json({ success: true }));
      }
      default: {
        return Promise.resolve(Response.json({}, { status: 404 }));
      }
    }
  };
  return {
    fetch,
    state: () => ({ cookie, sessions: [...sessions] }),
  };
};

describe("signing this browser in with a phone-approved session", () => {
  it("leaves only the browser's own cookie session", async () => {
    const server = fakeServer();
    const baseUrl = "https://api.shouldertap.app";
    await tradeBearerForCookie(
      new AccountClient({
        baseUrl,
        sessionToken: "phone-approved",
        fetch: server.fetch,
      }),
      new AccountClient({ baseUrl, fetch: server.fetch })
    );
    expect(server.state()).toStrictEqual({
      cookie: "session-2",
      sessions: ["session-2"],
    });
  });
});
