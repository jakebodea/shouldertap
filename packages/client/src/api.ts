import {
  type AcknowledgeRequest,
  Authorization,
  type CreateInboxRequest,
  type CredentialKind,
  type RedeemInviteRequest,
  type SendTapRequest,
  ShouldertapApi,
} from "@shouldertap/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

/** A typed client for the Shouldertap API, derived from the shared spec. */
export const makeShouldertapClient = (baseUrl: string, token: string | null) =>
  HttpApiClient.make(ShouldertapApi, { baseUrl }).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
        next(token ? HttpClientRequest.bearerToken(request, token) : request)
      )
    ),
    Effect.provide(FetchHttpClient.layer)
  );

export type ShouldertapClient = Effect.Success<
  ReturnType<typeof makeShouldertapClient>
>;

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "expired"
  | "rate_limited"
  | "payment_required"
  | "unavailable"
  | "network";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(
    code: ApiErrorCode,
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

const TRAILING_SLASH = /\/$/;
const HTTP_SCHEME = /^http/;

const domainErrors: Record<string, { code: ApiErrorCode; status: number }> = {
  InvalidRequest: { code: "invalid_request", status: 400 },
  HttpApiSchemaError: { code: "invalid_request", status: 400 },
  SchemaError: { code: "invalid_request", status: 400 },
  Unauthorized: { code: "unauthorized", status: 401 },
  NotFound: { code: "not_found", status: 404 },
  Conflict: { code: "conflict", status: 409 },
  Expired: { code: "expired", status: 410 },
  TooManyRequests: { code: "rate_limited", status: 429 },
  PaymentRequired: { code: "payment_required", status: 402 },
  Unavailable: { code: "unavailable", status: 503 },
};

const toApiError = (failure: unknown): ApiError => {
  const tag = (failure as { _tag?: string } | null)?._tag ?? "";
  const known = domainErrors[tag];
  const message =
    (failure as { message?: string } | null)?.message ||
    (failure instanceof Error ? failure.message : "Request failed");
  if (known) {
    return new ApiError(known.code, message, known.status, { cause: failure });
  }
  // Transport failures, unexpected statuses and defects: retryable.
  const status =
    (failure as { response?: { status?: number } } | null)?.response?.status ??
    0;
  return new ApiError("network", message, status, { cause: failure });
};

/**
 * Promise facade over the typed client for React/React Native code. Each
 * method maps typed failures to `ApiError` with a stable `code`.
 */
export class ApiClient {
  readonly baseUrl: string;
  readonly token: string | null;
  private client: Promise<ShouldertapClient> | null = null;

  constructor(options: {
    readonly baseUrl: string;
    readonly token?: string | null;
  }) {
    this.baseUrl = options.baseUrl.replace(TRAILING_SLASH, "");
    this.token = options.token ?? null;
  }

  withToken(token: string | null): ApiClient {
    return new ApiClient({ baseUrl: this.baseUrl, token });
  }

  get socketUrl(): string {
    return `${this.baseUrl.replace(HTTP_SCHEME, "ws")}/v1/connect`;
  }

  createInbox(payload: CreateInboxRequest) {
    return this.call((c) => c.pairing.createInbox({ payload }));
  }

  redeemInvite(payload: RedeemInviteRequest) {
    return this.call((c) => c.pairing.redeemInvite({ payload }));
  }

  me() {
    return this.call((c) => c.inbox.me());
  }

  createInvite(kind: CredentialKind) {
    return this.call((c) => c.inbox.createInvite({ payload: { kind } }));
  }

  sendTap(payload: SendTapRequest) {
    return this.call((c) => c.inbox.sendTap({ payload }));
  }

  markDisplayed(tapId: string) {
    return this.call((c) => c.inbox.markDisplayed({ params: { id: tapId } }));
  }

  acknowledge(tapId: string, payload: AcknowledgeRequest) {
    return this.call((c) =>
      c.inbox.acknowledge({ params: { id: tapId }, payload })
    );
  }

  revoke(credentialId: string) {
    return this.call((c) => c.inbox.revoke({ params: { id: credentialId } }));
  }

  connectTicket() {
    return this.call((c) => c.inbox.connectTicket());
  }

  private async call<A, E>(
    request: (client: ShouldertapClient) => Effect.Effect<A, E>
  ): Promise<A> {
    this.client ??= Effect.runPromise(
      makeShouldertapClient(this.baseUrl, this.token)
    );
    const client = await this.client;
    const exit = await Effect.runPromiseExit(request(client));
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    throw toApiError(Cause.squash(exit.cause));
  }
}

export const isRetryable = (error: unknown): boolean =>
  !(error instanceof ApiError) ||
  error.code === "network" ||
  error.status >= 500;
