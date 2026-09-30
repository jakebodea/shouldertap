import {
  type ErrorCode,
  errorStatus,
  parseBearer,
  parseToken,
} from "@shouldertap/domain";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { ENV } from "./env.server";
import type { Result } from "./inbox";

export { Inbox } from "./inbox";

/**
 * Thin HTTP ingress. It parses credentials to find the recipient's inbox
 * and forwards to that Durable Object, which authenticates and owns state.
 */
const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    // Bearer credentials only, no cookies: any origin may call the API.
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);

const inbox = (inboxId: string) => ENV.INBOX.getByName(inboxId);

const failure = (c: Context, code: ErrorCode, message: string) =>
  c.json({ error: { code, message } }, errorStatus[code] as 400);

const reply = <A>(c: Context, result: Result<A>, status: 200 | 201 = 200) =>
  result.ok
    ? c.json(result.value as object, status)
    : failure(c, result.error.code, result.error.message);

const body = (c: Context): Promise<unknown> => c.req.json().catch(() => null);

const authorized = (c: Context) => parseBearer(c.req.header("Authorization"));

app.get("/", (c) => c.text("Shouldertap API"));

app.post("/v1/inboxes", async (c) => {
  const inboxId = crypto.randomUUID().replaceAll("-", "");
  return reply(c, await inbox(inboxId).initialize(inboxId, await body(c)), 201);
});

app.post("/v1/invites/redeem", async (c) => {
  const input = (await body(c)) as { code?: unknown } | null;
  const code = typeof input?.code === "string" ? parseToken(input.code) : null;
  if (!code) {
    return failure(c, "not_found", "This invite link isn't valid");
  }
  return reply(c, await inbox(code.inboxId).redeemInvite(code, input), 201);
});

app.get("/v1/connect", (c) => {
  const ticket = parseToken(c.req.query("ticket") ?? "");
  if (!ticket) {
    return failure(c, "unauthorized", "Invalid ticket");
  }
  return inbox(ticket.inboxId).fetch(c.req.raw);
});

// Everything below requires `Authorization: Bearer <credential>`.

app.get("/v1/me", async (c) => {
  const token = authorized(c);
  return token
    ? reply(c, await inbox(token.inboxId).snapshot(token))
    : failure(c, "unauthorized", "Missing credential");
});

app.post("/v1/invites", async (c) => {
  const token = authorized(c);
  return token
    ? reply(
        c,
        await inbox(token.inboxId).createInvite(token, await body(c)),
        201
      )
    : failure(c, "unauthorized", "Missing credential");
});

app.post("/v1/taps", async (c) => {
  const token = authorized(c);
  return token
    ? reply(c, await inbox(token.inboxId).sendTap(token, await body(c)), 201)
    : failure(c, "unauthorized", "Missing credential");
});

app.post("/v1/taps/:id/displayed", async (c) => {
  const token = authorized(c);
  return token
    ? reply(
        c,
        await inbox(token.inboxId).markDisplayed(token, c.req.param("id"))
      )
    : failure(c, "unauthorized", "Missing credential");
});

app.post("/v1/taps/:id/acknowledge", async (c) => {
  const token = authorized(c);
  return token
    ? reply(
        c,
        await inbox(token.inboxId).acknowledge(
          token,
          c.req.param("id"),
          await body(c)
        )
      )
    : failure(c, "unauthorized", "Missing credential");
});

app.delete("/v1/credentials/:id", async (c) => {
  const token = authorized(c);
  return token
    ? reply(c, await inbox(token.inboxId).revoke(token, c.req.param("id")))
    : failure(c, "unauthorized", "Missing credential");
});

app.post("/v1/connect-tickets", async (c) => {
  const token = authorized(c);
  return token
    ? reply(c, await inbox(token.inboxId).createTicket(token), 201)
    : failure(c, "unauthorized", "Missing credential");
});

export default app;
