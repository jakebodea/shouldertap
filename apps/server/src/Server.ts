import {
  Authorization,
  Caller,
  NotFound,
  parseToken,
  ShouldertapApi,
  TooManyRequests,
  Unauthorized,
} from "@shouldertap/domain";
import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
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
import { Inbox, InboxLive } from "./Inbox";

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
              const inboxId = yield* newInboxId;
              // A fresh random id can't already exist; Conflict would be a bug.
              return yield* inboxes
                .getByName(inboxId)
                .initialize(inboxId, payload)
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
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.sendTap(token, payload)
          )
        )
        .handle("markDisplayed", ({ params }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.markDisplayed(token, params.id)
          )
        )
        .handle("acknowledge", ({ params, payload }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.acknowledge(token, params.id, payload)
          )
        )
        .handle("revoke", ({ params }) =>
          Effect.flatMap(forCaller, ({ token, stub }) =>
            stub.revoke(token, params.id)
          )
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
            allowedMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
        if (request.url === "/" || request.url === "") {
          return HttpServerResponse.text("Shouldertap API");
        }
        return yield* api;
      }),
    };
  }).pipe(Effect.provide([InboxLive, Cloudflare.Workers.RateLimitBinding]))
) {}
