import type { CredentialGrant, Invite, PersonColor } from "@shouldertap/domain";

import { ApiError } from "./api";
import type { ApiErrorCode } from "./api";

/**
 * The account protocol from docs/onboarding.md: email sign-in, the person's
 * profile, device sync and invites. The browser authenticates with its
 * session cookie; native clients pass the session token as a bearer.
 */

export type AccountPlatform = "iphone" | "mac" | "windows" | "web";

export interface Profile {
  readonly name: string;
  readonly color: PersonColor;
}

export interface Me {
  readonly email: string;
  /** Null until the person picks a name and color (the You step). */
  readonly profile: Profile | null;
  readonly suggestedName: string | null;
  readonly inboxId: string | null;
}

/** A sender key for one of your people: you → them. */
export interface SenderGrant {
  /** `${inboxId}:${credentialId}` */
  readonly id: string;
  readonly grant: CredentialGrant;
  /** Your name as they see it. */
  readonly name: string;
  readonly color: PersonColor;
}

export interface SyncRequest {
  readonly platform: AccountPlatform;
  readonly deviceName: string;
  readonly receive: boolean;
  readonly tokens: readonly string[];
}

export interface SyncResult {
  readonly me: Me;
  readonly inbox: CredentialGrant | null;
  readonly senders: readonly SenderGrant[];
  readonly removed: readonly string[];
}

export interface InvitePreview {
  readonly name: string;
  readonly color: PersonColor | null;
  readonly expiresAt: number;
}

export interface AcceptResult {
  readonly person: {
    readonly name: string;
    readonly color: PersonColor | null;
  };
  /** Null when you were already connected. */
  readonly sender: SenderGrant | null;
  readonly mutual: boolean;
}

export interface SignInResult {
  readonly token: string;
  readonly user: { readonly email: string };
}

/** A QR code a signed-in device shows for another to scan and sign in. */
export interface QrSignIn {
  readonly token: string;
  /** `https://shouldertap.app/qr#<token>`; draw this. */
  readonly url: string;
  readonly expiresAt: number;
}

export interface QrSignInStatus {
  readonly status: "pending" | "used" | "expired";
  /** Who scanned it, once used. */
  readonly platform: AccountPlatform | null;
}

/** A signed-out device asking a signed-in phone to approve it. */
export interface DeviceSignIn {
  readonly deviceCode: string;
  readonly userCode: string;
  /** Show as the QR code; the phone reads `user_code` from it. */
  readonly url: string;
  readonly interval: number;
  readonly expiresAt: number;
}

export type DeviceSignInPoll =
  | { readonly kind: "signed-in"; readonly token: string }
  | { readonly kind: "pending"; readonly interval: number }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" };

export type DeviceClient =
  | "shouldertap-ios"
  | "shouldertap-mac"
  | "shouldertap-windows"
  | "shouldertap-web";

/** The token in a scanned sign-in QR code, or null for anything else. */
export const qrSignInToken = (scanned: string): string | null => {
  const match = scanned
    .trim()
    .match(
      /^(?:https:\/\/[^/]+\/qr|shouldertap:\/\/qr)#(?<token>[A-Za-z0-9]{16,128})$/u
    );
  return match?.groups?.token ?? null;
};

/** The user code in a scanned device sign-in QR code, or null. */
export const deviceSignInCode = (scanned: string): string | null => {
  let url: URL;
  try {
    url = new URL(scanned.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/account/device") {
    return null;
  }
  return url.searchParams.get("user_code") || null;
};

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The most a device sends to `/account/sync`. */
export const MAX_SYNC_TOKENS = 50;

const TRAILING_SLASH = /\/$/u;

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "expired",
  429: "rate_limited",
};

const codeFor = (status: number): ApiErrorCode =>
  STATUS_CODES[status] ?? (status >= 500 ? "unavailable" : "invalid_request");

/** `{ error }` from account routes, `{ message }` from the auth library. */
const messageOf = (body: unknown): string | null => {
  if (body && typeof body === "object") {
    if ("error" in body && typeof body.error === "string") {
      return body.error;
    }
    if ("message" in body && typeof body.message === "string") {
      return body.message;
    }
  }
  return null;
};

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class AccountClient {
  readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly sessionToken: string | null;

  /**
   * Without `sessionToken` the client sends cookies (the browser); with one,
   * it sends `Authorization: Bearer` (native apps).
   */
  constructor(options: {
    /** Unset in builds without a server (the download e2e build). Pages
     * that never call the account must still load, so it isn't required. */
    readonly baseUrl: string | undefined;
    readonly sessionToken?: string | null;
    readonly fetch?: Fetch;
  }) {
    this.baseUrl = (options.baseUrl ?? "").replace(TRAILING_SLASH, "");
    this.sessionToken = options.sessionToken ?? null;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Emails a six-digit code; a new request rotates it. */
  sendCode(email: string) {
    return this.request<{ success: boolean }>(
      "POST",
      "/api/auth/email-otp/send-verification-otp",
      { email, type: "sign-in" }
    );
  }

  /** A wrong or expired code fails with `invalid_request`. */
  signIn(email: string, otp: string) {
    return this.request<SignInResult>("POST", "/api/auth/sign-in/email-otp", {
      email,
      otp,
    });
  }

  /** A sign-in QR code for another device; needs a session. */
  createQrSignIn() {
    return this.request<QrSignIn>("POST", "/api/auth/qr-sign-in/create", {});
  }

  /** Whether the QR code from `createQrSignIn` was scanned. */
  qrSignInStatus(token: string) {
    return this.request<QrSignInStatus>("POST", "/api/auth/qr-sign-in/status", {
      token,
    });
  }

  /** Signs this device in with a scanned QR code; the browser gets a cookie. */
  redeemQrSignIn(token: string, platform: AccountPlatform) {
    return this.request<SignInResult>("POST", "/api/auth/qr-sign-in/redeem", {
      token,
      platform,
    });
  }

  /** Starts signing this device in by a phone scanning its QR code. */
  async startDeviceSignIn(client: DeviceClient): Promise<DeviceSignIn> {
    const grant = await this.request<{
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      interval: number;
      expires_in: number;
    }>("POST", "/api/auth/device/code", { client_id: client });
    return {
      deviceCode: grant.device_code,
      userCode: grant.user_code,
      url: grant.verification_uri_complete,
      interval: grant.interval,
      expiresAt: Date.now() + grant.expires_in * 1000,
    };
  }

  /** One poll of a device sign-in; call again after `interval` seconds. */
  async pollDeviceSignIn(
    client: DeviceClient,
    started: DeviceSignIn,
    interval = started.interval
  ): Promise<DeviceSignInPoll> {
    try {
      const { access_token: token } = await this.request<{
        access_token: string;
      }>("POST", "/api/auth/device/token", {
        client_id: client,
        device_code: started.deviceCode,
        grant_type: DEVICE_GRANT,
      });
      return { kind: "signed-in", token };
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      switch (error.message) {
        case "authorization_pending": {
          return { kind: "pending", interval };
        }
        case "slow_down": {
          return { kind: "pending", interval: interval + 5 };
        }
        case "access_denied": {
          return { kind: "denied" };
        }
        case "expired_token":
        case "invalid_grant": {
          return { kind: "expired" };
        }
        default: {
          throw error;
        }
      }
    }
  }

  /** Which kind of device a scanned code would sign in; needs a session. */
  async reviewDeviceSignIn(userCode: string) {
    const review = await this.request<{
      user_code: string;
      client_id: string;
      status: string;
    }>("GET", `/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
    return {
      userCode: review.user_code,
      client: review.client_id,
      pending: review.status === "pending",
    };
  }

  async approveDeviceSignIn(userCode: string) {
    await this.request<unknown>("POST", "/api/auth/device/approve", {
      userCode,
    });
  }

  async denyDeviceSignIn(userCode: string) {
    await this.request<unknown>("POST", "/api/auth/device/deny", { userCode });
  }

  /** Ends the account session; this device's messaging keys stay. */
  async signOut() {
    await this.request<unknown>("POST", "/api/auth/sign-out", {});
  }

  /** Deletes the account. The server refuses while billing needs it. */
  async deleteAccount() {
    await this.request<unknown>("POST", "/api/auth/delete-user", {});
  }

  me() {
    return this.request<Me>("GET", "/account/me");
  }

  /** The signed-in person, or null when there is no session. */
  async session(): Promise<Me | null> {
    try {
      return await this.me();
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") {
        return null;
      }
      throw error;
    }
  }

  setProfile(profile: Profile) {
    return this.request<Me>("POST", "/account/profile", profile);
  }

  sync(request: SyncRequest) {
    return this.request<SyncResult>("POST", "/account/sync", {
      ...request,
      tokens: request.tokens.slice(0, MAX_SYNC_TOKENS),
    });
  }

  /** An invite to tap you, for a device without an inbox token. */
  createInvite() {
    return this.request<Invite>("POST", "/account/invite", {});
  }

  /** Who an invite is from. Needs no session. */
  previewInvite(code: string) {
    return this.request<InvitePreview>(
      "GET",
      `/v1/invites/preview?code=${encodeURIComponent(code)}`
    );
  }

  accept(request: {
    readonly code: string;
    readonly platform: AccountPlatform;
    readonly deviceName: string;
  }) {
    return this.request<AcceptResult>("POST", "/account/accept", request);
  }

  /**
   * Stops tapping someone from every device on the account. `id` is the
   * sender id from sync or accept (`${inboxId}:${credentialId}`).
   */
  removePerson(id: string) {
    return this.request<{ removed: true }>("POST", "/account/remove", { id });
  }

  /**
   * A Creem checkout for the account's membership (or a new one); open the
   * returned URL. The server refuses a second subscription.
   */
  patronCheckout(patronId?: string) {
    return this.request<{ url: string }>("POST", "/account/patron/checkout", {
      patronId,
    });
  }

  /** The billing portal for one of the account's memberships. */
  managePatron(patronId?: string) {
    return this.request<{ url: string }>("POST", "/account/patron/manage", {
      patronId,
    });
  }

  private async request<A>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<A> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.sessionToken) {
      headers.Authorization = `Bearer ${this.sessionToken}`;
    }
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        credentials: this.sessionToken ? "omit" : "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError("network", "Couldn't reach Shouldertap", 0, {
        cause: error,
      });
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(
        codeFor(response.status),
        messageOf(parsed) ?? "Request failed",
        response.status
      );
    }
    return parsed as A;
  }
}
