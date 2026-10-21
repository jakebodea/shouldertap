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
  RedeemInviteRequest,
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
import type { ParsedToken } from "./token";

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
    // Optional annual support; never needed to send or receive.
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
    // The recipient's own screens; devices only. Conflict: a theme other
    // than Default needs active patron support.
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

export class ShouldertapApi extends HttpApi.make("shouldertap")
  .add(PairingGroup)
  .add(InboxGroup) {}
