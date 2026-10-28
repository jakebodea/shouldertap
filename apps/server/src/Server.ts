import {
  Authorization,
  Caller,
  Conflict,
  fallbackColor,
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
import { invitePreview, peopleAction } from "./account-people";
import { analyticsPerson, capture, patronEventName } from "./analytics";
import type { Track } from "./analytics";
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
import { DEFAULT_THEME, themeForSend } from "./presentation";
import { RequestBackground, withRequestBackground } from "./request-api";
import { SenderPatron, SenderPatronLive } from "./SenderPatron";
import { TrialLedger, TrialLedgerLive } from "./TrialLedger";
import {
  captureAccountEmail,
  isVerificationStage,
  verificationResponse,
  verificationRateLimitKey,
} from "./verification-mail";

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
    const verification = Option.exists(stage, isVerificationStage);
    const webOrigin = yield* Config.String("SHOULDERTAP_WEB_ORIGIN").pipe(
      Config.withDefault("http://localhost:3001")
    );
    const apiPort = yield* Config.Number("SHOULDERTAP_API_PORT").pipe(
      Config.withDefault(3000)
    );
    const verificationToken = verification
      ? yield* Config.Redacted("SHOULDERTAP_VERIFY_TOKEN")
      : undefined;
    if (
      verificationToken &&
      (!Redacted.value(verificationToken).startsWith("st-verify-") ||
        Redacted.value(verificationToken).length < 32)
    ) {
      return yield* Effect.die(
        new Error(
          "Verification token must be runner-generated (st-verify-) and have at least 32 characters"
        )
      );
    }
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
        SOURCE_REVISION: process.env.COMMIT_SHA ?? "local",
        SOURCE_DIGEST: yield* Config.String("SHOULDERTAP_SOURCE_DIGEST").pipe(
          Config.withDefault("unrecorded")
        ),
        ACCOUNT_PRODUCTION: production ? "true" : "false",
        RATE_LIMIT_SCOPE: Option.getOrElse(stage, () => "local"),
        ACCOUNT_WEB_ORIGIN: production ? `https://${domains.web}` : webOrigin,
        ...(verificationToken
          ? {
              VERIFICATION_TOKEN: verificationToken,
              VERIFICATION_API_ORIGIN: yield* Config.String(
                "SHOULDERTAP_API_ORIGIN"
              ).pipe(Config.withDefault(`http://localhost:${apiPort}`)),
              VERIFICATION_DB: yield* Cloudflare.D1.Database(
                "VerificationMail",
                { migrations: "./apps/server/src/verification-migrations" }
              ),
            }
          : {}),
        ...(production
          ? {
              ACCOUNT_EMAIL: yield* Cloudflare.Email.SendEmail("AccountEmail", {
                allowedSenderAddresses: [accountEmail],
              }),
            }
          : {}),
      },
      dev: { port: apiPort },
    };
  }),
  Effect.gen(function* serverMain() {
    const accountEnv = (yield* Cloudflare.Workers
      .WorkerEnvironment) as unknown as {
      ACCOUNT_DB: D1Database;
      ACCOUNT_SECRET: string;
      SOURCE_REVISION: string;
      SOURCE_DIGEST: string;
      ACCOUNT_PRODUCTION: string;
      RATE_LIMIT_SCOPE: string;
      ACCOUNT_EMAIL?: AccountEmailBinding;
      ACCOUNT_WEB_ORIGIN: string;
      VERIFICATION_TOKEN?: string;
      VERIFICATION_API_ORIGIN?: string;
      VERIFICATION_DB?: D1Database;
    };
    const verificationMailbox =
      accountEnv.VERIFICATION_DB && accountEnv.VERIFICATION_TOKEN
        ? {
            database: accountEnv.VERIFICATION_DB,
            token: accountEnv.VERIFICATION_TOKEN,
          }
        : undefined;
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

    // Analytics is optional too: without the PostHog project token
    // (previews, dev) nothing is reported.
    const posthogToken = yield* Config.option(
      Config.String("POSTHOG_PROJECT_TOKEN")
    );
    /** Reports after the response is sent; never delays or fails it. */
    const track: Track = (event, at) =>
      Option.match(posthogToken, {
        onNone: () => Effect.void,
        onSome: (token) =>
          RequestBackground.pipe(
            Effect.flatMap((exec) =>
              exec.waitUntil(
                Effect.tryPromise(() =>
                  analyticsPerson(accountEnv.ACCOUNT_DB, event)
                ).pipe(
                  Effect.flatMap((personId) =>
                    capture(token, event, at, personId)
                  ),
                  Effect.catchCause(() =>
                    Effect.logWarning("Could not report product event")
                  )
                )
              )
            ),
            Effect.catchCause(() =>
              Effect.logWarning("Could not schedule product event")
            )
          ),
      });

    const patronCheckoutAvailable = checkoutAvailable(
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
    const livePushContext = Option.match(apns, {
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

    const pushContext: Effect.Effect<PushContext | undefined> =
      verificationMailbox
        ? Effect.succeed({
            jwt: "verification-only",
            verification: {
              url: `${accountEnv.VERIFICATION_API_ORIGIN}/__verify/push`,
              token: verificationMailbox.token,
            },
          })
        : livePushContext;

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
                  key: verificationRateLimitKey(
                    accountEnv.RATE_LIMIT_SCOPE,
                    request.headers["cf-connecting-ip"] ?? "unknown",
                    request.headers,
                    accountEnv.VERIFICATION_TOKEN
                  ),
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
              const grant = yield* inboxes
                .getByName(inboxId)
                .initialize(inboxId, names)
                .pipe(Effect.orDie);
              yield* track(
                {
                  name: "inbox_created",
                  inboxId,
                  userId: null,
                  platform: names.platform ?? "mac",
                },
                Date.now()
              );
              return grant;
            })
          )
          .handle("previewInvite", ({ query }) =>
            invitePreview({ db: accountEnv.ACCOUNT_DB, inboxes }, query.code)
          )
          .handle("redeemInvite", ({ payload }) => {
            const code = parseToken(payload.code);
            return code
              ? pushContext.pipe(
                  Effect.flatMap((push) =>
                    inboxes
                      .getByName(code.inboxId)
                      .redeemInvite(code, payload, push)
                  ),
                  Effect.tap((grant) =>
                    track(
                      {
                        name: "invite_redeemed",
                        inboxId: code.inboxId,
                        credentialId: grant.credentialId,
                        kind: grant.kind,
                        userId: null,
                        // Senders' platform is ignored; older Macs omit it.
                        platform:
                          grant.kind === "device"
                            ? (payload.platform ?? "mac")
                            : null,
                      },
                      Date.now()
                    )
                  )
                )
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
              Effect.gen(function* createShareableInvite() {
                const invite = yield* stub.createInvite(token, payload);
                if (invite.kind !== "sender") {
                  return invite;
                }
                const person = yield* invitePreview(
                  { db: accountEnv.ACCOUNT_DB, inboxes },
                  invite.code
                ).pipe(Effect.orDie);
                return {
                  ...invite,
                  inviter: {
                    name: person.name,
                    color: person.color ?? fallbackColor(person.name),
                  },
                };
              })
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
            const tap = yield* stub.sendTap(
              token,
              message,
              theme,
              yield* pushContext
            );
            yield* track(
              {
                name: "tap_sent",
                inboxId: token.inboxId,
                tapId: tap.id,
                senderId: tap.senderId,
                themed: theme !== DEFAULT_THEME,
              },
              tap.createdAt
            );
            return tap;
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
            const tap = yield* stub.acknowledge(
              token,
              params.id,
              payload,
              yield* pushContext
            );
            yield* track(
              {
                name: "tap_answered",
                inboxId: token.inboxId,
                tapId: tap.id,
                deviceId: token.id,
                response: tap.response?.kind ?? payload.response.kind,
              },
              tap.acknowledgedAt ?? Date.now()
            );
            return tap;
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
                  key: verificationRateLimitKey(
                    accountEnv.RATE_LIMIT_SCOPE,
                    request.headers["cf-connecting-ip"] ?? "unknown",
                    request.headers,
                    accountEnv.VERIFICATION_TOKEN
                  ),
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
        const { applied } = yield* owner.kind === "patron"
          ? patrons.getByName(owner.id).recordEvent(action.event)
          : inboxes.getByName(owner.id).recordPatronEvent(action.event);
        const name = patronEventName(action.event.type);
        // Only the first delivery of a fact: Creem retries and replays.
        if (applied && name) {
          yield* track(
            {
              name,
              creemEventId: action.event.id,
              ownerId: owner.id,
              ownerKind: owner.kind,
            },
            action.event.at
          );
        }
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
        if (verificationMailbox && request.url.startsWith("/__verify/")) {
          const webRequest = yield* toWeb(request).pipe(Effect.orDie);
          const response = yield* Effect.promise(() =>
            verificationResponse(webRequest, verificationMailbox)
          );
          return HttpServerResponse.fromWeb(response);
        }
        if (
          request.url.startsWith("/api/auth/") ||
          request.url.startsWith("/account")
        ) {
          const webRequest = yield* toWeb(request).pipe(Effect.orDie);
          const origin =
            accountEnv.ACCOUNT_PRODUCTION === "true"
              ? `https://${domains.api}`
              : new URL(webRequest.url).origin;
          const webOrigin = accountEnv.ACCOUNT_WEB_ORIGIN;
          const run = Effect.runPromiseWith(
            yield* Effect.context<RuntimeContext>()
          );
          const auth = createAccountAuth({
            database: accountEnv.ACCOUNT_DB,
            secret: accountEnv.ACCOUNT_SECRET,
            origin,
            webOrigin,
            email: accountEnv.VERIFICATION_DB
              ? captureAccountEmail(accountEnv.VERIFICATION_DB)
              : accountEnv.ACCOUNT_EMAIL,
            onAccountCreated: (user) =>
              run(
                track(
                  {
                    name: "account_created",
                    userId: user.id,
                    email: user.email,
                  },
                  user.createdAt.getTime()
                )
              ),
            onAccountDeleted: (user) =>
              run(
                track({ name: "account_deleted", userId: user.id }, Date.now())
              ),
          });
          const response = yield* Effect.promise(() =>
            handleAccountHttp(webRequest, {
              auth,
              origin,
              webOrigin,
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
                const deps = {
                  db: accountEnv.ACCOUNT_DB,
                  inboxes,
                  patrons,
                  track,
                  pushContext,
                };
                const action = Effect.gen(function* dispatchAccount() {
                  if (path.startsWith("/account/patron/")) {
                    return yield* accountBilling(
                      {
                        ...deps,
                        webOrigin,
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
              sourceRevision: accountEnv.SOURCE_REVISION,
              sourceDigest: accountEnv.SOURCE_DIGEST,
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
      }).pipe(withRequestBackground),
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
