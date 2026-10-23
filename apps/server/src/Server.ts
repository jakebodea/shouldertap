import {
  Authorization,
  Caller,
  Conflict,
  NotFound,
  parsePatronKey,
  parseToken,
  PatronAuthorization,
  PatronCaller,
  ShouldertapApi,
  TooManyRequests,
  Unauthorized,
  Unavailable,
} from "@shouldertap/domain";
import { Stage, makeRandom } from "alchemy";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest, toWeb } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { accountEmail, domains, isProduction } from "../../../domains.ts";
import { createAccountAuth } from "./account-auth";
import { accountBilling, checkoutAvailable } from "./account-billing";
import { deleteAccount } from "./account-delete";
import type { AccountEmailBinding } from "./account-email";
import { handleAccountHttp } from "./account-http";
import { accountAction } from "./account-identity";
import { accountPage } from "./account-page";
import { invitePreview, peopleAction } from "./account-people";
import { makeProviderTokens } from "./apns";
import type { PushContext } from "./apns";
import {
  checkoutInboxId,
  customerPortal,
  subscriptionOwner,
  creemClient,
  verifyWebhook,
  readWebhookAction,
} from "./Creem";
import { Inbox, InboxLive } from "./Inbox";
import { themeForSend } from "./presentation";
import { SenderPatron, SenderPatronLive } from "./SenderPatron";
import { TrialLedger, TrialLedgerLive } from "./TrialLedger";

const newInboxId = Effect.sync(() => crypto.randomUUID().replaceAll("-", ""));
const newPatronId = newInboxId;

/** Shown to a recipient's (older) app that tries to buy support for itself. */
const RECEIVER_CHECKOUT_RETIRED =
  "Patron support now belongs to the person sending taps: it lets them send taps in a theme to everyone they tap. Receiving and answering stay free.";

/**
 * An effect that succeeds with nothing. `Effect.void` is `Effect<void>`, which
 * isn't assignable to the `T | undefined` the Inbox's push and trial
 * parameters take.
 */
const absent = <T>(): Effect.Effect<T | undefined> =>
  // oxlint-disable-next-line unicorn/no-useless-undefined -- the typed value, see above
  Effect.succeed(undefined);

/** New inboxes per client IP per minute. Approximate and per Cloudflare location. */
const INBOX_CREATION_LIMIT = 10;

/**
 * Public API. Parses credentials only far enough to find the recipient's
 * Inbox; the Inbox authenticates, authorizes, and owns all state.
 */
export default class Server extends Cloudflare.Worker<Server>()(
  "server",
  Effect.gen(function* props() {
    // Stage exists at deploy time only; the deployed Worker re-evaluates these
    // props without it, where the domain no longer matters.
    const stage = yield* Effect.serviceOption(Stage);
    const production = Option.exists(stage, isProduction);
    const accountDatabase = yield* Cloudflare.D1.Database("Accounts", {
      migrations: "./apps/server/account-migrations",
    });
    const accountSecret = yield* makeRandom("AccountSecret");
    return {
      main: import.meta.url,
      compatibility: { date: "2026-08-31", flags: ["nodejs_compat"] },
      observability: { enabled: true },
      version: { tag: process.env.COMMIT_SHA ?? "local" },
      domain: production ? domains.api : undefined,
      // Previews cannot send real sign-in messages from the production domain.
      env: {
        ACCOUNT_DB: accountDatabase,
        ACCOUNT_SECRET: accountSecret,
        ACCOUNT_PRODUCTION: production ? "true" : "false",
        ...(production
          ? {
              // Live merchant and USD 24/year sender-theme product verified before rollout.
              PATRON_CHECKOUT_ENABLED: "true",
              ACCOUNT_EMAIL: yield* Cloudflare.Email.SendEmail("AccountEmail", {
                allowedSenderAddresses: [accountEmail],
              }),
            }
          : {}),
      },
      dev: { port: 3000 },
    };
  }),
  Effect.gen(function* serverMain() {
    const accountEnv = (yield* Cloudflare.Workers
      .WorkerEnvironment) as unknown as {
      ACCOUNT_DB: D1Database;
      ACCOUNT_SECRET: string;
      ACCOUNT_PRODUCTION: string;
      ACCOUNT_EMAIL?: AccountEmailBinding;
    };
    const inboxes = yield* Inbox;
    const versionMetadata = yield* Cloudflare.Workers.VersionMetadata();
    const patrons = yield* SenderPatron;
    // Payments are optional so previews and dev run without Creem: checkout
    // answers 503 and the webhook 404 until all three are configured.
    const creem = Option.all({
      apiKey: yield* Config.option(Config.Redacted("CREEM_API_KEY")),
      webhookSecret: yield* Config.option(
        Config.Redacted("CREEM_WEBHOOK_SECRET")
      ),
      productId: Option.some(
        yield* Config.String("CREEM_PRODUCT_ID").pipe(Config.withDefault(""))
      ),
      patronProductId: Option.some(
        yield* Config.String("CREEM_PATRON_PRODUCT_ID").pipe(
          Config.withDefault("")
        )
      ),
    }).pipe(
      Option.map((config) => ({
        ...config,
        client: creemClient(Redacted.value(config.apiKey)),
      }))
    );

    // Production explicitly opts in above; other stages default to no new checkouts.
    // Existing subscription management, webhooks and free messages are unaffected.
    const patronCheckoutEnabled = yield* Config.Boolean(
      "PATRON_CHECKOUT_ENABLED"
    ).pipe(Config.withDefault(false));
    const patronCheckoutAvailable = checkoutAvailable(
      patronCheckoutEnabled,
      Option.getOrUndefined(creem)
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
      onNone: () => absent<PushContext>(),
      onSome: (tokens) =>
        tokens.pipe(
          Effect.map((context): PushContext | undefined => context),
          Effect.catchCause((cause) =>
            Effect.logError("Couldn't sign an APNs token", cause).pipe(
              Effect.andThen(absent<PushContext>())
            )
          )
        ),
    });

    // Keep the binding/data for older purchases and rollback; no new fingerprints
    // are looked up or recorded now that core messaging is free.
    yield* TrialLedger;

    const inboxCreation = yield* Cloudflare.RateLimit("INBOX_CREATION", {
      namespaceId: 7201,
      simple: { limit: INBOX_CREATION_LIMIT, period: 60 },
    });

    const patronCreation = yield* Cloudflare.RateLimit("PATRON_CREATION", {
      namespaceId: 7202,
      simple: { limit: INBOX_CREATION_LIMIT, period: 60 },
    });

    const PatronAuthorizationLive = Layer.succeed(
      PatronAuthorization,
      PatronAuthorization.of({
        bearer: (httpEffect, { credential }) => {
          const key = parsePatronKey(Redacted.value(credential));
          return key
            ? Effect.provideService(httpEffect, PatronCaller, key)
            : Effect.fail(
                new Unauthorized({ message: "Missing or malformed patron key" })
              );
        },
      })
    );

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
            Effect.gen(function* createInbox() {
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
              // Accepted from older clients, no longer used.
              void machine;
              const inboxId = yield* newInboxId;
              // A fresh random id can't already exist; Conflict would be a bug.
              return yield* inboxes
                .getByName(inboxId)
                .initialize(inboxId, names)
                .pipe(Effect.orDie);
            })
          )
          .handle("previewInvite", ({ query }) =>
            invitePreview({ db: accountEnv.ACCOUNT_DB, inboxes }, query.code)
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
      const forCaller = Effect.gen(function* forCaller() {
        const token = yield* Caller;
        return { token, stub: inboxes.getByName(token.inboxId) };
      });
      return handlers
        .handle("me", () =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.snapshot(token))
          )
        )
        .handle("createInvite", ({ payload }) =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) =>
              stub.createInvite(token, payload)
            )
          )
        )
        .handle("sendTap", ({ payload }) =>
          Effect.gen(function* sendTap() {
            const { token, stub } = yield* forCaller;
            const { theme: requested, patronKey, ...message } = payload;
            // Only the sender's own patron key can put a theme on a tap.
            const theme = yield* themeForSend(requested, patronKey, (key) =>
              patrons.getByName(key.patronId).isActive(key)
            );
            return yield* stub.sendTap(
              token,
              message,
              theme,
              yield* pushContext
            );
          })
        )
        .handle("markDisplayed", ({ params }) =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) =>
              stub.markDisplayed(token, params.id)
            )
          )
        )
        .handle("acknowledge", ({ params, payload }) =>
          Effect.gen(function* acknowledge() {
            const { token, stub } = yield* forCaller;
            return yield* stub.acknowledge(
              token,
              params.id,
              payload,
              yield* pushContext
            );
          })
        )
        .handle("deleteTap", ({ params }) =>
          Effect.gen(function* deleteTap() {
            const { token, stub } = yield* forCaller;
            return yield* stub.deleteTap(token, params.id, yield* pushContext);
          })
        )
        .handle("registerPush", ({ payload }) =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) =>
              stub.registerPush(token, payload)
            )
          )
        )
        .handle("activityToken", ({ params, payload }) =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) =>
              stub.activityToken(token, params.id, payload)
            )
          )
        )
        .handle("revoke", ({ params }) =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.revoke(token, params.id))
          )
        )
        .handle("deleteSender", () =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.deleteSender(token))
          )
        )
        .handle("createCheckout", () =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.requireDevice(token)),
            Effect.flatMap(() =>
              Effect.fail(
                new Conflict({
                  message:
                    "Shouldertap is now free. Update the app to see what's new.",
                })
              )
            )
          )
        )
        .handle("createPatronCheckout", () =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.requireDevice(token)),
            Effect.flatMap(() =>
              Effect.fail(new Conflict({ message: RECEIVER_CHECKOUT_RETIRED }))
            )
          )
        )
        .handle("claimSupportPrompt", () =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.requireDevice(token)),
            Effect.as({ show: false })
          )
        )
        .handle("managePatron", () =>
          Effect.gen(function* managePatron() {
            const { token, stub } = yield* forCaller;
            const customerId = yield* stub.patronCustomer(token);
            if (Option.isNone(creem)) {
              return yield* new Unavailable({
                message: "Billing is unavailable here.",
              });
            }
            const url = yield* customerPortal(
              creem.value.client,
              customerId
            ).pipe(
              Effect.mapError(
                () =>
                  new Unavailable({
                    message: "Couldn't open billing. Try again shortly.",
                  })
              )
            );
            return { url };
          })
        )
        .handle("updateAppearance", ({ payload }) =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) =>
              stub.updateAppearance(token, payload)
            )
          )
        )
        .handle("connectTicket", () =>
          forCaller.pipe(
            Effect.flatMap(({ token, stub }) => stub.createTicket(token))
          )
        );
    });

    const patronSetup = HttpApiBuilder.group(
      ShouldertapApi,
      "patronSetup",
      (handlers) =>
        handlers
          .handle("patronAvailability", () =>
            Effect.succeed({ checkoutEnabled: patronCheckoutAvailable })
          )
          .handle("createPatron", () =>
            Effect.gen(function* createPatron() {
              const request = yield* HttpServerRequest;
              const { success } = yield* patronCreation
                .limit({
                  key: request.headers["cf-connecting-ip"] ?? "unknown",
                })
                .pipe(
                  Effect.catchTag("RateLimitError", () =>
                    Effect.succeed({ success: true })
                  )
                );
              if (!success) {
                return yield* new TooManyRequests({
                  message:
                    "Too many requests from this network. Try again in a minute.",
                });
              }
              const patronId = yield* newPatronId;
              return yield* patrons
                .getByName(patronId)
                .initialize(patronId)
                .pipe(Effect.orDie);
            })
          )
          .handle("redeemPatronLink", ({ payload }) => {
            const code = parsePatronKey(payload.code);
            return code
              ? patrons.getByName(code.patronId).redeemLinkCode(code)
              : Effect.fail(new NotFound({ message: "This code isn't valid" }));
          })
    );

    const patron = HttpApiBuilder.group(
      ShouldertapApi,
      "patron",
      (handlers) => {
        const forPatron = Effect.gen(function* forPatron() {
          const key = yield* PatronCaller;
          return { key, stub: patrons.getByName(key.patronId) };
        });
        return handlers
          .handle("patronStatus", () =>
            forPatron.pipe(Effect.flatMap(({ key, stub }) => stub.status(key)))
          )
          .handle("patronCheckout", () =>
            Effect.gen(function* accountRequiredForCheckout() {
              const { key, stub } = yield* forPatron;
              yield* stub.status(key);
              return yield* new Conflict({
                message:
                  "Sign in at https://shouldertap.app/account to start patron support. Existing memberships can still be managed here.",
              });
            })
          )
          .handle("patronManage", () =>
            Effect.gen(function* managePatron() {
              const { key, stub } = yield* forPatron;
              const customerId = yield* stub.customer(key);
              if (Option.isNone(creem)) {
                return yield* new Unavailable({
                  message: "Billing is unavailable here.",
                });
              }
              const url = yield* customerPortal(
                creem.value.client,
                customerId
              ).pipe(
                Effect.mapError(
                  () =>
                    new Unavailable({
                      message: "Couldn't open billing. Try again shortly.",
                    })
                )
              );
              return { url };
            })
          )
          .handle("patronLinkCode", () =>
            forPatron.pipe(
              Effect.flatMap(({ key, stub }) => stub.createLinkCode(key))
            )
          )
          .handle("forgetPatronKey", () =>
            forPatron.pipe(
              Effect.flatMap(({ key, stub }) => stub.forgetKey(key))
            )
          );
      }
    );

    const api = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(ShouldertapApi).pipe(
        Layer.provide([pairing, inbox, patronSetup, patron]),
        Layer.provide([AuthorizationLive, PatronAuthorizationLive]),
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
    const creemWebhook = Effect.gen(function* creemWebhook() {
      if (Option.isNone(creem)) {
        return HttpServerResponse.text("Not found", { status: 404 });
      }
      const { client, productId, patronProductId, webhookSecret } = creem.value;
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
      const action = yield* readWebhookAction(
        client,
        body,
        productId,
        patronProductId
      );
      if (action.kind === "patron") {
        const owner =
          action.owner ??
          (yield* subscriptionOwner(client, action.subscriptionId));
        if (!owner) {
          return HttpServerResponse.text("Missing subscription metadata", {
            status: 500,
          });
        }
        // Each fact goes only to the subject named in its own metadata: a
        // historical receiver subscription never becomes a sender's.
        yield* owner.kind === "patron"
          ? patrons.getByName(owner.id).recordEvent(action.event)
          : inboxes.getByName(owner.id).recordPatronEvent(action.event);
      } else if (action.kind === "purchase") {
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
      // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- Effect.catch, not Promise#catch
      Effect.catch((error) =>
        Effect.logError("Creem webhook failed", error).pipe(
          Effect.as(HttpServerResponse.text("Try again", { status: 500 }))
        )
      )
    );

    return {
      fetch: Effect.gen(function* fetch() {
        const request = yield* HttpServerRequest;
        if (
          request.url.startsWith("/api/auth/") ||
          request.url.startsWith("/account")
        ) {
          const webRequest = yield* toWeb(request).pipe(Effect.orDie);
          const origin =
            accountEnv.ACCOUNT_PRODUCTION === "true"
              ? `https://${domains.api}`
              : new URL(webRequest.url).origin;
          const webOrigin =
            accountEnv.ACCOUNT_PRODUCTION === "true"
              ? `https://${domains.web}`
              : "http://localhost:3001";
          const auth = createAccountAuth({
            database: accountEnv.ACCOUNT_DB,
            secret: accountEnv.ACCOUNT_SECRET,
            origin,
            webOrigin,
            email: accountEnv.ACCOUNT_EMAIL,
          });
          const run = Effect.runPromiseWith(
            yield* Effect.context<RuntimeContext>()
          );
          const response = yield* Effect.promise(() =>
            handleAccountHttp(webRequest, {
              auth,
              origin,
              webOrigin,
              page: (url) => accountPage(url, webOrigin),
              deleteAccount: (userId, incoming) =>
                run(
                  deleteAccount(accountEnv.ACCOUNT_DB, patrons, userId, () =>
                    auth.handler(incoming)
                  ).pipe(
                    Effect.catchTags({
                      Conflict: (error) =>
                        Effect.succeed(
                          Response.json(
                            { error: error.message },
                            { status: 409 }
                          )
                        ),
                      Unauthorized: (error) =>
                        Effect.succeed(
                          Response.json(
                            { error: error.message },
                            { status: 401 }
                          )
                        ),
                    })
                  )
                ),
              accountRequest: async (userId, incoming) => {
                const path = new URL(incoming.url).pathname;
                const isRead =
                  path === "/account/data" ||
                  path === "/account/me" ||
                  path === "/account/patron/status";
                if (incoming.method !== (isRead ? "GET" : "POST")) {
                  return Response.json(
                    { error: "Method not allowed" },
                    { status: 405 }
                  );
                }
                const body: unknown = isRead ? {} : await incoming.json();
                const deps = { db: accountEnv.ACCOUNT_DB, inboxes, patrons };
                const action = Effect.gen(function* dispatchAccount() {
                  if (path.startsWith("/account/patron/")) {
                    return yield* accountBilling(
                      {
                        ...deps,
                        origin,
                        enabled: patronCheckoutEnabled,
                        billing: Option.getOrUndefined(creem),
                      },
                      userId,
                      path.slice("/account/patron/".length),
                      body
                    );
                  }
                  const people = peopleAction(
                    deps,
                    userId,
                    path.slice("/account/".length),
                    body
                  );
                  if (people) {
                    return yield* people;
                  }
                  return yield* accountAction(
                    deps,
                    userId,
                    path.slice("/account/".length),
                    body
                  );
                });
                return run(
                  action.pipe(
                    Effect.map((value) => Response.json(value)),
                    Effect.catchTags({
                      InvalidRequest: (error) =>
                        Effect.succeed(
                          Response.json(
                            { error: error.message },
                            { status: 400 }
                          )
                        ),
                      Unauthorized: (error) =>
                        Effect.succeed(
                          Response.json(
                            { error: error.message },
                            { status: 403 }
                          )
                        ),
                      Conflict: (error) =>
                        Effect.succeed(
                          Response.json(
                            { error: error.message },
                            { status: 409 }
                          )
                        ),
                      Unavailable: (error) =>
                        Effect.succeed(
                          Response.json(
                            { error: error.message },
                            { status: 503 }
                          )
                        ),
                      CreemError: () =>
                        Effect.succeed(
                          Response.json(
                            {
                              error:
                                "Billing could not be reached. Try again later.",
                            },
                            { status: 503 }
                          )
                        ),
                    })
                  )
                );
              },
            })
          );
          return HttpServerResponse.fromWeb(response);
        }
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
        // A provider redirect is navigation only, never proof of payment.
        // No credentials, query values or remote markup are reflected here.
        if (
          request.url.split("?")[0] === "/v1/patrons/return" &&
          request.method === "GET"
        ) {
          return HttpServerResponse.text(
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Shouldertap</title><main><h1>Return to Shouldertap</h1><p>Return to the Shouldertap tab you started from. If checkout replaced it, use your browser’s Back button to return to Style. Your draft is saved.</p><p>Your membership updates only after our server receives payment confirmation. If it is still processing, refresh Style shortly.</p></main></html>`,
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "content-security-policy":
                  "default-src 'none'; frame-ancestors 'none'",
              },
            }
          );
        }
        if (request.url === "/v1/webhooks/creem" && request.method === "POST") {
          return yield* creemWebhook;
        }
        if (request.url === "/version" && request.method === "GET") {
          const version = yield* versionMetadata;
          return yield* HttpServerResponse.json(
            {
              versionId: version.id,
              revision: version.tag,
              deployedAt: version.timestamp,
              coreMessaging: "free",
              patronCheckoutEnabled: patronCheckoutAvailable,
            },
            { headers: { "cache-control": "no-store" } }
          );
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
      SenderPatronLive,
      TrialLedgerLive,
      Cloudflare.Workers.RateLimitBinding,
      Cloudflare.Workers.VersionMetadataBinding,
    ])
  )
) {}
