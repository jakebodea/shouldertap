// Local fictional data for native marketing captures, never a production service.
// Run: bun brand/app-store/fixture-server.mjs
import {
  messages,
  recipient,
  repliesFor,
  senderFor,
  senders,
} from "./messages.mjs";

const token = "marketing.sender01.fictional00000001";
const deviceToken = "marketing.device01.fictional00000001";
const sockets = new Set();
const session = "marketing.session01.fictional00000001";
// The phone's own sender key belongs to SHOULDERTAP_FIXTURE_SENDER (a messages.mjs key, default
// "dinner"); incoming taps take their sender from their body.
const { name: senderName, color: senderColor } =
  senders[process.env.SHOULDERTAP_FIXTURE_SENDER ?? "dinner"];
const me = {
  email: "nina@example.com",
  profile: { name: recipient, color: "sky" },
  inboxId: "inbox01",
  sendProfile: { name: senderName, color: senderColor },
};
const taps = [];
let sequence = 1;
const credential = (id, kind, name, extra = {}) => ({
  id,
  kind,
  name,
  createdAt: Date.now() - 86_400_000,
  lastSeenAt: Date.now(),
  ...extra,
});
const announce = (tap) => {
  for (const ws of sockets) {
    ws.send(JSON.stringify({ v: 1, type: "tap", tap }));
  }
};
const { json } = Response;
const newTap = (body) => {
  const sender = senderFor(body.body);
  return {
    id: body.requestId,
    senderId: "sender01",
    senderName: sender.name,
    senderColor: sender.color,
    body: body.body,
    replies: body.replies ?? repliesFor(body.body),
    // A sender theme, as a patron's tap carries (no key checked here).
    ...(body.theme ? { theme: body.theme } : {}),
    createdAt: Date.now(),
    state: "pending",
    displayedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    response: null,
    sequence: (sequence += 1),
  };
};
// POST /capture/display or /capture/reply: the latest tap was seen, or answered.
const capture = (body, answered) => {
  const [tap] = taps;
  if (!tap) {
    return new Response("Send a tap first", { status: 409 });
  }
  tap.displayedAt = Date.now();
  sequence += 1;
  tap.sequence = sequence;
  if (answered) {
    Object.assign(tap, {
      state: "acknowledged",
      acknowledgedAt: Date.now(),
      acknowledgedBy: `${recipient}’s MacBook`,
      response: { kind: "text", text: body.text ?? messages.reply },
    });
  }
  announce(tap);
  return json(tap);
};
// Account sign-in (any email, any six-digit code): the phone is Nina's
// inbox and holds one sender's key to tap Nina, so it shows both sides.
const routes = {
  "/api/auth/email-otp/send-verification-otp": () => json({ success: true }),
  "/api/auth/sign-in/email-otp": () =>
    json({ token: session, user: { email: me.email } }),
  "/v1/patrons/availability": () => json({ checkoutEnabled: false }),
  "/account/me": () => json(me),
  "/account/sync": () =>
    json({
      me,
      inbox: {
        kind: "device",
        credentialId: "device01",
        token: deviceToken,
        recipientName: recipient,
      },
      senders: [
        {
          id: `${me.inboxId}:sender01`,
          grant: {
            kind: "sender",
            credentialId: "sender01",
            token,
            recipientName: recipient,
          },
          name: senderName,
          color: senderColor,
        },
      ],
      removed: [],
    }),
  "/v1/connect-tickets": () =>
    json({ ticket: "local-fixture", expiresAt: Date.now() + 60_000 }),
  "/v1/me": (_, device) =>
    json({
      kind: device ? "device" : "sender",
      credentialId: device ? "device01" : "sender01",
      recipientName: recipient,
      senderName,
      senderColor,
      sequence,
      taps,
      credentials: [
        ...Object.entries(senders).map(([key, person]) =>
          credential(`sender-${key}`, "sender", person.name, {
            color: person.color,
          })
        ),
        credential("mac00001", "device", `${recipient}’s MacBook`, {
          platform: "mac",
        }),
        credential("device01", "device", `${recipient}’s iPhone`, {
          platform: "iphone",
        }),
      ],
      plan: { status: "paid", trialEndsAt: 0 },
    }),
  // The Add People screen's invite link and QR code.
  "/v1/invites": (body) =>
    json({
      kind: body.kind ?? "sender",
      code: "marketing.invite01.fictional00000001",
      expiresAt: Date.now() + 7 * 86_400_000,
    }),
  "/v1/taps": (body) => {
    const tap = newTap(body);
    taps.unshift(tap);
    announce(tap);
    return json(tap);
  },
  "/capture/display": (body) => capture(body, false),
  "/capture/reply": (body) => capture(body, true),
  "/v1/push": () => json({ registered: true }),
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4318,
  async fetch(req, listener) {
    const { pathname } = new URL(req.url);
    if (pathname === "/v1/connect") {
      return listener.upgrade(req)
        ? undefined
        : new Response("Upgrade required", { status: 400 });
    }
    const route = routes[pathname];
    if (!route) {
      return new Response("Unsupported fixture route", { status: 404 });
    }
    const body =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const device = req.headers.get("authorization") === `Bearer ${deviceToken}`;
    return route(body, device);
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    close(ws) {
      sockets.delete(ws);
    },
    message(ws, message) {
      if (message === "ping") {
        ws.send("pong");
      }
    },
  },
});
console.log(`Fictional capture API: ${server.url}`);
