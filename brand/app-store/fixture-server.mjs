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
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4318,
  async fetch(req, listener) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/v1/connect") {
      if (listener.upgrade(req)) {
        return;
      }
      return new Response("Upgrade required", { status: 400 });
    }
    const body =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const device = req.headers.get("authorization") === `Bearer ${deviceToken}`;
    const { json } = Response;
    // Account sign-in (any email, any six-digit code): the phone is Nina's
    // inbox and holds one sender's key to tap Nina, so it shows both sides.
    if (path === "/api/auth/email-otp/send-verification-otp") {
      return json({ success: true });
    }
    if (path === "/api/auth/sign-in/email-otp") {
      return json({ token: session, user: { email: me.email } });
    }
    if (path === "/v1/patrons/availability") {
      return json({ checkoutEnabled: false });
    }
    if (path === "/account/me") {
      return json(me);
    }
    if (path === "/account/sync") {
      return json({
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
      });
    }
    if (path === "/v1/connect-tickets") {
      return json({ ticket: "local-fixture", expiresAt: Date.now() + 60_000 });
    }
    if (path === "/v1/me") {
      return json({
        kind: device ? "device" : "sender",
        credentialId: device ? "device01" : "sender01",
        recipientName: recipient,
        senderName,
        senderColor,
        sequence,
        taps,
        credentials: [
          credential("sender01", "sender", senderName, { color: senderColor }),
          credential("mac00001", "device", `${recipient}’s MacBook`, {
            platform: "mac",
          }),
          credential("device01", "device", `${recipient}’s iPhone`, {
            platform: "iphone",
          }),
        ],
        plan: { status: "paid", trialEndsAt: 0 },
      });
    }
    if (path === "/v1/taps") {
      const tap = {
        id: body.requestId,
        senderId: "sender01",
        senderName: senderFor(body.body).name,
        senderColor: senderFor(body.body).color,
        body: body.body,
        replies: body.replies ?? repliesFor(body.body),
        createdAt: Date.now(),
        state: "pending",
        displayedAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        response: null,
        sequence: (sequence += 1),
      };
      taps.unshift(tap);
      announce(tap);
      return json(tap);
    }
    if (path === "/capture/display" || path === "/capture/reply") {
      const [tap] = taps;
      if (!tap) {
        return new Response("Send a tap first", { status: 409 });
      }
      tap.displayedAt = Date.now();
      sequence += 1;
      tap.sequence = sequence;
      if (path.endsWith("reply")) {
        Object.assign(tap, {
          state: "acknowledged",
          acknowledgedAt: Date.now(),
          acknowledgedBy: `${recipient}’s MacBook`,
          response: { kind: "text", text: body.text ?? messages.reply },
        });
      }
      announce(tap);
      return json(tap);
    }
    if (path === "/v1/push") {
      return json({ registered: true });
    }
    return new Response("Unsupported fixture route", { status: 404 });
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
