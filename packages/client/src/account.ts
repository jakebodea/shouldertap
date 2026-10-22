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
    readonly baseUrl: string;
    readonly sessionToken?: string | null;
    readonly fetch?: Fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(TRAILING_SLASH, "");
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
