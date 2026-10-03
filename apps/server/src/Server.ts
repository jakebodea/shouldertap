import {
  Authorization,
  Caller,
  NotFound,
  parseToken,
  ShouldertapApi,
  TooManyRequests,
  Unauthorized,
  Unavailable,
} from "@shouldertap/domain";
import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { domains, isProduction } from "../../../domains.ts";
import { makeProviderTokens, type PushContext } from "./apns";
import {
  checkoutInboxId,
  createCheckout,
  creemClient,
  verifyWebhook,
  webhookAction,
} from "./Creem";
import { Inbox, InboxLive } from "./Inbox";
import { TrialLedger, TrialLedgerLive } from "./TrialLedger";

const newInboxId = Effect.sync(() => crypto.randomUUID().replaceAll("-", ""));

/** New inboxes per client IP per minute. Approximate and per Cloudflare location. */
const INBOX_CREATION_LIMIT = 10;

/**
 * Public API. Parses credentials only far enough to find the recipient's
 * Inbox; the Inbox authenticates, authorizes, and owns all state.
 */
export default class Server extends Cloudflare.Worker<Server>()(
  "server",
  Effect.gen(function* () {
    // Stage exists at deploy time only; the deployed Worker re-evaluates these
    // props without it, where the domain no longer matters.
    const stage = yield* Effect.serviceOption(Stage);
    const production = Option.exists(stage, isProduction);
    return {
      main: import.meta.url,
      compatibility: { date: "2026-08-31" },
      observability: { enabled: true },
      domain: production ? domains.api : undefined,
      dev: { port: 3000 },
    };
  }),
  Effect.gen(function* () {
    const inboxes = yield* Inbox;
    // Payments are optional so previews and dev run without Creem: checkout
    // answers 503 and the webhook 404 until all three are configured.
    const creem = Option.all({
      apiKey: yield* Config.option(Config.Redacted("CREEM_API_KEY")),
      webhookSecret: yield* Config.option(
        Config.Redacted("CREEM_WEBHOOK_SECRET")
      ),
      productId: yield* Config.option(Config.String("CREEM_PRODUCT_ID")),
    }).pipe(
      Option.map((config) => ({
        ...config,
        client: creemClient(Redacted.value(config.apiKey)),
      }))
    );

    // APNs is optional too: without the key, linked iPhones simply get no
    // pushes (previews, dev). The .p8 file's contents go in APNS_KEY.
    const apns = Option.all({
      p8: yield* Config.option(Config.Redacted("APNS_KEY")),
      keyId: yield* Config.option(Config.String("APNS_KEY_ID")),
      teamId: yield* Config.option(Config.String("APNS_TEAM_ID")),
    }).pipe(
      Option.map(({ p8, ...rest }) =>
        makeProviderTokens({ p8: Redacted.value(p8), ...rest })
      )
    );
    /** A signed provider token for the Inbox, or nothing without APNs. */
    const pushContext = Option.match(apns, {
      onNone: () => Effect.succeed(undefined),
      onSome: (tokens) =>
        tokens.pipe(
          Effect.map((context): PushContext | undefined => context),
          Effect.catchCause((cause) =>
            Effect.logError("Couldn't sign an APNs token", cause).pipe(
              Effect.as(undefined)
            )
          )
        ),
    });

    const trialLedgers = yield* TrialLedger;
    /**
     * When this Mac's free trial ends, per its ledger. Fails open: if the
     * ledger can't answer, the new inbox gets a normal trial (undefined)
     * rather than the Mac being unable to set up.
     */
    const claimTrial = (machine: string) =>
      trialLedgers
        .getByName(machine)
        .claim()
        .pipe(
          Effect.map(({ trialEndsAt }): number | undefined => trialEndsAt),
          Effect.timeout("5 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("Trial ledger unavailable", cause).pipe(
              Effect.as(undefined)
            )
          )
        );

    const inboxCreation = yield* Cloudflare.RateLimit("INBOX_CREATION", {
      namespaceId: 7201,
      simple: { limit: INBOX_CREATION_LIMIT, period: 60 },
    });

    const AuthorizationLive = Layer.succeed(
      Authorization,
      Authorization.of({
        bearer: (httpEffect, { credential }) => {
          const token = parseToken(Redacted.value(credential));
          return token
            ? Effect.provideService(httpEffect, Caller, token)
            : Effect.fail(
                new Unauthorized({ message: "Missing or malformed credential" })
              );
        },
      })
    );

    const pairing = HttpApiBuilder.group(
      ShouldertapApi,
      "pairing",
      (handlers) =>
        handlers
          .handle("createInbox", ({ payload }) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest;
              const { success } = yield* inboxCreation
                .limit({
                  key: request.headers["cf-connecting-ip"] ?? "unknown",
                })
                .pipe(
                  // Fail open: a limiter outage shouldn't block setting up a Mac.
                  Effect.catchTag("RateLimitError", () =>
                    Effect.succeed({ success: true })
                  )
                );
              if (!success) {
                return yield* new TooManyRequests({
                  message:
                    "Too many new inboxes from this network. Try again in a minute.",
                });
              }
              const { machine, ...names } = payload;
              const trialEndsAt = machine
                ? yield* claimTrial(machine)
                : undefined;
              const inboxId = yield* newInboxId;
              // A fresh random id can't already exist; Conflict would be a bug.
              return yield* inboxes
                .getByName(inboxId)
                .initialize(inboxId, names, trialEndsAt)
                .pipe(Effect.orDie);
            })
          )
          .handle("redeemInvite", ({ payload }) => {
            const code = parseToken(payload.code);
            return code
              ? inboxes.getByName(code.inboxId).redeemInvite(code, payload)
              : Effect.fail(
                  new NotFound({ message: "This invite link isn't valid" })
                );
          })
    );

    const inbox = HttpApiBuilder.group(ShouldertapApi, "inbox", (handlers) => {
      const forCaller = Effect.gen(function* () {
        const token = yield* Caller;
        return { token, stub: inboxes.getByName(token.inboxId) };
      });
      return handlers
        .handle("me", () =>
          Effect.flatMap(forCaller, ({ token, stub }) => stub.snapshot(token))
        )
        .handle("createInvite", ({ payload }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.createInvite(token, payload)
          )
        )
        .handle("sendTap", ({ payload }) =>
          Effect.gen(function* () {
            const { token, stub } = yield* forCaller;
            return yield* stub.sendTap(token, payload, yield* pushContext);
          })
        )
        .handle("markDisplayed", ({ params }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.markDisplayed(token, params.id)
          )
        )
        .handle("acknowledge", ({ params, payload }) =>
          Effect.gen(function* () {
            const { token, stub } = yield* forCaller;
            return yield* stub.acknowledge(
              token,
              params.id,
              payload,
              yield* pushContext
            );
          })
        )
        .handle("registerPush", ({ payload }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.registerPush(token, payload)
          )
        )
        .handle("activityToken", ({ params, payload }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.activityToken(token, params.id, payload)
          )
        )
        .handle("revoke", ({ params }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.revoke(token, params.id)
          )
        )
        .handle("deleteSender", () =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.deleteSender(token)
          )
        )
        .handle("createCheckout", () =>
          Effect.gen(function* () {
            const { token, stub } = yield* forCaller;
            const context = yield* stub.checkoutContext(token);
            if (Option.isNone(creem)) {
              return yield* new Unavailable({
                message: "Payments aren't set up here yet.",
              });
            }
            const url = yield* createCheckout(creem.value.client, {
              productId: creem.value.productId,
              inboxId: context.inboxId,
            }).pipe(
              Effect.tapError((error) => Effect.logError(error)),
              Effect.mapError(
                () =>
                  new Unavailable({
                    message: "Couldn't start checkout. Try again in a minute.",
                  })
              )
            );
            return { url };
          })
        )
        .handle("connectTicket", () =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.createTicket(token)
          )
        );
    });

    const api = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(ShouldertapApi).pipe(
        Layer.provide([pairing, inbox]),
        Layer.provide(AuthorizationLive),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        // Bearer credentials only, no cookies: any origin may call the API.
        Layer.provide(
          HttpRouter.cors({
            allowedOrigins: ["*"],
            allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            // Effect clients propagate W3C trace context alongside the credential.
            allowedHeaders: [
              "authorization",
              "content-type",
              "traceparent",
              "tracestate",
              "b3",
            ],
          })
        )
      )
    );

    /**
     * Creem's webhook: verified against the raw body, then applied to the
     * inbox named in the checkout metadata. A 5xx makes Creem retry, so only
     * transient failures answer one; anything we'll never act on gets 200.
     */
    const creemWebhook = Effect.gen(function* () {
      if (Option.isNone(creem)) {
        return HttpServerResponse.text("Not found", { status: 404 });
      }
      const { client, productId, webhookSecret } = creem.value;
      const request = yield* HttpServerRequest;
      const body = yield* request.text.pipe(Effect.orDie);
      const verified = yield* verifyWebhook(
        body,
        request.headers,
        Redacted.value(webhookSecret)
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      );
      if (!verified) {
        return HttpServerResponse.text("Invalid signature", { status: 400 });
      }
      const action = yield* Effect.try(() =>
        webhookAction(body, productId)
      ).pipe(
        Effect.catch(() =>
          Effect.succeed({
            kind: "ignore",
            reason: "unreadable payload",
          } as const)
        )
      );
      if (action.kind === "purchase") {
        const at = Date.now();
        const { applied } = yield* inboxes
          .getByName(action.inboxId)
          .recordPurchase({ orderId: action.orderId, email: action.email, at });
        yield* Effect.logInfo("Creem purchase", { applied });
      } else if (action.kind === "refund") {
        const inboxId =
          action.inboxId ??
          (action.checkoutId
            ? yield* checkoutInboxId(client, action.checkoutId)
            : null);
        if (inboxId) {
          const { applied } = yield* inboxes
            .getByName(inboxId)
            .recordRefund(action.orderId);
          yield* Effect.logInfo("Creem refund", { applied });
        } else {
          yield* Effect.logWarning("Creem refund for an unknown inbox");
        }
      } else {
        yield* Effect.logInfo(`Creem webhook ignored: ${action.reason}`);
      }
      return HttpServerResponse.text("ok");
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Creem webhook failed", error).pipe(
          Effect.as(HttpServerResponse.text("Try again", { status: 500 }))
        )
      )
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/v1/connect?")) {
          // WebSocket upgrade with a one-time ticket; the Inbox accepts it.
          const query = request.url.slice(request.url.indexOf("?") + 1);
          const ticket = parseToken(
            new URLSearchParams(query).get("ticket") ?? ""
          );
          if (
            !ticket ||
            request.headers.upgrade?.toLowerCase() !== "websocket"
          ) {
            return HttpServerResponse.text(
              "Expected a WebSocket upgrade with a valid ticket",
              {
                status: 400,
              }
            );
          }
          return yield* inboxes.getByName(ticket.inboxId).fetch(request);
        }
        if (request.url === "/v1/webhooks/creem" && request.method === "POST") {
          return yield* creemWebhook;
        }
        if (request.url === "/" || request.url === "") {
          return HttpServerResponse.text("Shouldertap API");
        }
        return yield* api;
      }),
    };
  }).pipe(
    Effect.provide([
      InboxLive,
      TrialLedgerLive,
      Cloudflare.Workers.RateLimitBinding,
    ])
  )
) {}
