import {
  type AcknowledgeRequest,
  ConnectTicket,
  type CreateInboxRequest,
  CredentialGrant,
  type CredentialKind,
  ErrorBody,
  type ErrorCode,
  Invite,
  type RedeemInviteRequest,
  type SendTapRequest,
  Snapshot,
  Tap,
} from "@shouldertap/domain";
import { Schema } from "effect";

export class ApiError extends Error {
  readonly code: ErrorCode | "network";
  readonly status: number;

  constructor(
    code: ErrorCode | "network",
    message: string,
    status: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const decodeError = Schema.decodeUnknownOption(ErrorBody);
const TRAILING_SLASH = /\/$/;
const HTTP_SCHEME = /^http/;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  readonly token?: string | null;
}

/** Plain HTTPS JSON client for the Shouldertap API, decoding every response. */
export class ApiClient {
  readonly baseUrl: string;
  readonly token: string | null;
  private readonly fetchImpl: Fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(TRAILING_SLASH, "");
    this.token = options.token ?? null;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  withToken(token: string | null): ApiClient {
    return new ApiClient({
      baseUrl: this.baseUrl,
      token,
      fetch: this.fetchImpl,
    });
  }

  get socketUrl(): string {
    return `${this.baseUrl.replace(HTTP_SCHEME, "ws")}/v1/connect`;
  }

  createInbox(request: CreateInboxRequest) {
    return this.request(CredentialGrant, "POST", "/v1/inboxes", request);
  }

  redeemInvite(request: RedeemInviteRequest) {
    return this.request(CredentialGrant, "POST", "/v1/invites/redeem", request);
  }

  me() {
    return this.request(Snapshot, "GET", "/v1/me");
  }

  createInvite(kind: CredentialKind) {
    return this.request(Invite, "POST", "/v1/invites", { kind });
  }

  sendTap(request: SendTapRequest) {
    return this.request(Tap, "POST", "/v1/taps", request);
  }

  markDisplayed(tapId: string) {
    return this.request(
      Tap,
      "POST",
      `/v1/taps/${encodeURIComponent(tapId)}/displayed`
    );
  }

  acknowledge(tapId: string, request: AcknowledgeRequest) {
    return this.request(
      Tap,
      "POST",
      `/v1/taps/${encodeURIComponent(tapId)}/acknowledge`,
      request
    );
  }

  revoke(credentialId: string) {
    return this.request(
      Schema.Struct({ revoked: Schema.Literal(true) }),
      "DELETE",
      `/v1/credentials/${encodeURIComponent(credentialId)}`
    );
  }

  connectTicket() {
    return this.request(ConnectTicket, "POST", "/v1/connect-tickets");
  }

  private async request<
    S extends Schema.Top & { readonly DecodingServices: never },
  >(
    schema: S,
    method: string,
    path: string,
    body?: unknown
  ): Promise<S["Type"]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: cause is passed via the options argument
      throw new ApiError(
        "network",
        error instanceof Error ? error.message : "Network error",
        0,
        { cause: error }
      );
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const decoded = decodeError(json);
      if (decoded._tag === "Some") {
        throw new ApiError(
          decoded.value.error.code,
          decoded.value.error.message,
          response.status
        );
      }
      throw new ApiError(
        "network",
        `Request failed (${response.status})`,
        response.status
      );
    }
    return Schema.decodeUnknownSync(schema)(json);
  }
}

export const isRetryable = (error: unknown): boolean =>
  !(error instanceof ApiError) ||
  error.code === "network" ||
  error.status >= 500;
