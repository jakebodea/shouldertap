import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

import {
  AcknowledgeRequest,
  ConnectTicket,
  CreateInboxRequest,
  CreateInviteRequest,
  CredentialGrant,
  Invite,
  RedeemInviteRequest,
  SendTapRequest,
  Snapshot,
  Tap,
} from "./contracts";
import {
  Conflict,
  Expired,
  InvalidRequest,
  NotFound,
  TooManyRequests,
  Unauthorized,
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
    }),
    HttpApiEndpoint.post("sendTap", "/taps", {
      payload: SendTapRequest,
      success: Tap.pipe(created),
      error: Conflict,
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
    HttpApiEndpoint.delete("revoke", "/credentials/:id", {
      params: idParams,
      success: Schema.Struct({ revoked: Schema.Literal(true) }),
      error: NotFound,
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
