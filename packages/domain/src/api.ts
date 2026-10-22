import * as Context from "effect/Context";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as Schema from "effect/Schema";

import {
  AcknowledgeRequest,
  ActivityTokenRequest,
  Appearance,
  Checkout,
  ConnectTicket,
  CreateInboxRequest,
  CreateInviteRequest,
  CredentialGrant,
  Invite,
  PatronAvailability,
  PatronKeyGrant,
  PatronLinkCode,
  PatronStatus,
  InvitePreview,
  RedeemInviteRequest,
  RedeemPatronLinkRequest,
  RegisterPushRequest,
  SendTapRequest,
  Snapshot,
  Tap,
  UpdateAppearanceRequest,
} from "./contracts";
import {
  Conflict,
  Expired,
  InvalidRequest,
  NotFound,
  PaymentRequired,
  TooManyRequests,
  Unauthorized,
  Unavailable,
} from "./errors";
import type { ParsedPatronKey, ParsedToken } from "./token";

/**
 * The HTTP contract. A pure description: the Worker implements it and every
 * client derives a typed client from it. Realtime events are the separate
 * WebSocket protocol at `GET /v1/connect?ticket=…` (see `ServerEvent`).
 */

/** The caller's parsed bearer credential; the Inbox verifies it. */
export class Caller extends Context.Service<Caller, ParsedToken>()(
  "shouldertap/Caller"
) {}

export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: Caller }
>()("shouldertap/Authorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
  requiredForClient: true,
}) {}

/** The caller's parsed patron key; their Patron object verifies it. */
export class PatronCaller extends Context.Service<
  PatronCaller,
  ParsedPatronKey
>()("shouldertap/PatronCaller") {}

/** A sender's patron key: a bearer separate from any pairing credential. */
export class PatronAuthorization extends HttpApiMiddleware.Service<
  PatronAuthorization,
  { provides: PatronCaller }
>()("shouldertap/PatronAuthorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
  requiredForClient: true,
}) {}

const created = HttpApiSchema.status(201);
const idParams = { id: Schema.String };

export class PairingGroup extends HttpApiGroup.make("pairing")
  .add(
    HttpApiEndpoint.post("createInbox", "/inboxes", {
      payload: CreateInboxRequest,
      success: CredentialGrant.pipe(created),
      error: TooManyRequests,
    }),
    HttpApiEndpoint.post("redeemInvite", "/invites/redeem", {
      payload: RedeemInviteRequest,
      success: CredentialGrant.pipe(created),
      // Conflict: the inbox already has the maximum pairings of that kind.
      error: [NotFound, Expired, Conflict],
    }),
    HttpApiEndpoint.get("previewInvite", "/invites/preview", {
      query: { code: Schema.String },
      success: InvitePreview,
      error: [NotFound, Expired],
    })
  )
  .prefix("/v1") {}

export class InboxGroup extends HttpApiGroup.make("inbox")
  .add(
    HttpApiEndpoint.get("me", "/me", { success: Snapshot }),
    HttpApiEndpoint.post("createInvite", "/invites", {
      payload: CreateInviteRequest,
      success: Invite.pipe(created),
      error: Conflict,
    }),
    HttpApiEndpoint.post("sendTap", "/taps", {
      payload: SendTapRequest,
      success: Tap.pipe(created),
      // TooManyRequests: the sender's hourly tap limit.
      error: [Conflict, TooManyRequests, PaymentRequired, InvalidRequest],
    }),
    HttpApiEndpoint.post("markDisplayed", "/taps/:id/displayed", {
      params: idParams,
      success: Tap,
      error: NotFound,
    }),
    HttpApiEndpoint.post("acknowledge", "/taps/:id/acknowledge", {
      params: idParams,
      payload: AcknowledgeRequest,
      success: Tap,
      error: [NotFound, InvalidRequest],
    }),
    // A linked iPhone's push tokens; devices only.
    HttpApiEndpoint.put("registerPush", "/push", {
      payload: RegisterPushRequest,
      success: Schema.Struct({ registered: Schema.Literal(true) }),
    }),
    // A device deletes any tap; a sender only their own. Gone for everyone.
    HttpApiEndpoint.delete("deleteTap", "/taps/:id", {
      params: idParams,
      success: Schema.Struct({ deleted: Schema.Literal(true) }),
      error: NotFound,
    }),
    HttpApiEndpoint.post("activityToken", "/taps/:id/activity-token", {
      params: idParams,
      payload: ActivityTokenRequest,
      success: Schema.Struct({ saved: Schema.Literal(true) }),
      error: NotFound,
    }),
    HttpApiEndpoint.delete("revoke", "/credentials/:id", {
      params: idParams,
      success: Schema.Struct({ revoked: Schema.Literal(true) }),
      // Conflict: removing the last Mac while other devices remain.
      error: [NotFound, Conflict],
    }),
    HttpApiEndpoint.delete("deleteSender", "/sender", {
      success: Schema.Struct({ deleted: Schema.Literal(true) }),
    }),
    // Retired receiver-side purchases. `createCheckout` (the one-time
    // unlock) and `createPatronCheckout` (receiver-owned annual support)
    // always answer Conflict now: patron support belongs to the sender (see
    // PatronGroup). `managePatron` still opens a historical receiver
    // subscription so it can be canceled; `claimSupportPrompt` never shows.
    HttpApiEndpoint.post("createCheckout", "/checkout", {
      success: Checkout.pipe(created),
      error: [Conflict, Unavailable],
    }),
    HttpApiEndpoint.post("createPatronCheckout", "/patron/checkout", {
      success: Checkout.pipe(created),
      error: [Conflict, Unavailable],
    }),
    HttpApiEndpoint.post("managePatron", "/patron/manage", {
      success: Checkout,
      error: [Conflict, Unavailable],
    }),
    HttpApiEndpoint.post("claimSupportPrompt", "/patron/prompt", {
      success: Schema.Struct({ show: Schema.Boolean }),
    }),
    // The recipient's own screens (motion, plain override); devices only.
    // Free, never gated.
    HttpApiEndpoint.put("updateAppearance", "/appearance", {
      payload: UpdateAppearanceRequest,
      success: Appearance,
      error: Conflict,
    }),
    HttpApiEndpoint.post("connectTicket", "/connect-tickets", {
      success: ConnectTicket.pipe(created),
    })
  )
  .middleware(Authorization)
  .prefix("/v1") {}

/** Creating a sender's patron identity, or adding one of their devices. */
export class PatronSetupGroup extends HttpApiGroup.make("patronSetup")
  .add(
    // Whether "Become a patron" leads anywhere yet (PATRON_CHECKOUT_ENABLED
    // and a configured product), so pages never offer a dead-end checkout.
    HttpApiEndpoint.get("patronAvailability", "/patrons/availability", {
      success: PatronAvailability,
    }),
    HttpApiEndpoint.post("createPatron", "/patrons", {
      success: PatronKeyGrant.pipe(created),
      error: TooManyRequests,
    }),
    HttpApiEndpoint.post("redeemPatronLink", "/patrons/link", {
      payload: RedeemPatronLinkRequest,
      success: PatronKeyGrant.pipe(created),
      error: [NotFound, Expired, Conflict],
    })
  )
  .prefix("/v1") {}

/**
 * A sender's own patron membership, authenticated by their patron key. It
 * belongs to the sender, not to any recipient inbox, so one $24/year
 * membership covers taps to everyone they're paired with.
 */
export class PatronGroup extends HttpApiGroup.make("patron")
  .add(
    HttpApiEndpoint.get("patronStatus", "/patrons/me", {
      success: PatronStatus,
    }),
    HttpApiEndpoint.post("patronCheckout", "/patrons/me/checkout", {
      success: Checkout.pipe(created),
      error: [Conflict, Unavailable],
    }),
    HttpApiEndpoint.post("patronManage", "/patrons/me/manage", {
      success: Checkout,
      error: [Conflict, Unavailable],
    }),
    // Conflict: the identity already has the maximum keys.
    HttpApiEndpoint.post("patronLinkCode", "/patrons/me/link-codes", {
      success: PatronLinkCode.pipe(created),
      error: Conflict,
    }),
    // Forgets this device's key; the membership and other keys stay.
    HttpApiEndpoint.delete("forgetPatronKey", "/patrons/me/key", {
      success: Schema.Struct({ forgotten: Schema.Literal(true) }),
    })
  )
  .middleware(PatronAuthorization)
  .prefix("/v1") {}

export class ShouldertapApi extends HttpApi.make("shouldertap")
  .add(PairingGroup)
  .add(InboxGroup)
  .add(PatronSetupGroup)
  .add(PatronGroup) {}
