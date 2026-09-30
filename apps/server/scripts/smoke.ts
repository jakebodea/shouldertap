/**
 * End-to-end protocol check against a running API.
 *   bun apps/server/scripts/smoke.ts [baseUrl]
 * Creates a throwaway inbox, pairs a sender and a second Mac, and walks a
 * tap through send → display → acknowledge → revoke.
 */

import { ServerEvent, type Tap } from "@shouldertap/domain";
import * as Schema from "effect/Schema";

const HTTP_SCHEME = /^http/;
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

const call = async (
  method: string,
  path: string,
  token?: string,
  body?: unknown
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc assertions over raw JSON
  return { status: response.status, json: (await response.json()) as any };
};

const expect = (label: string, condition: boolean, detail?: unknown) => {
  if (!condition) {
    console.error(`✗ ${label}`, detail ?? "");
    process.exit(1);
  }
  console.log(`✓ ${label}`);
};

const listen = async (token: string) => {
  const { json } = await call("POST", "/v1/connect-tickets", token);
  const socket = new WebSocket(
    `${base.replace(HTTP_SCHEME, "ws")}/v1/connect?ticket=${json.ticket}`
  );
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", reject);
  });
  socket.addEventListener("message", (message) => {
    if (message.data === "pong") {
      return;
    }
    events.push(
      Schema.decodeUnknownSync(ServerEvent)(JSON.parse(String(message.data)))
    );
  });
  return { socket, events, ticket: json.ticket as string };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const macA = await call("POST", "/v1/inboxes", undefined, {
  recipientName: "Jake",
  deviceName: "Studio Mac",
});
expect("create inbox", macA.status === 201, macA.json);
const deviceToken: string = macA.json.token;

const senderInvite = await call("POST", "/v1/invites", deviceToken, {
  kind: "sender",
});
expect("create sender invite", senderInvite.status === 201, senderInvite.json);

const sender = await call("POST", "/v1/invites/redeem", undefined, {
  code: senderInvite.json.code,
  name: "Sam",
});
expect(
  "redeem sender invite",
  sender.status === 201 && sender.json.kind === "sender",
  sender.json
);
const senderToken: string = sender.json.token;

const reused = await call("POST", "/v1/invites/redeem", undefined, {
  code: senderInvite.json.code,
  name: "Eve",
});
expect("invite is one-time", reused.status === 410, reused.json);

const deviceInvite = await call("POST", "/v1/invites", deviceToken, {
  kind: "device",
});
const macB = await call("POST", "/v1/invites/redeem", undefined, {
  code: deviceInvite.json.code,
  name: "Laptop",
});
expect(
  "pair second Mac",
  macB.status === 201 && macB.json.kind === "device",
  macB.json
);

const senderCannotInvite = await call("POST", "/v1/invites", senderToken, {
  kind: "sender",
});
expect("sender cannot invite", senderCannotInvite.status === 401);

const a = await listen(deviceToken);
const b = await listen(macB.json.token);
const s = await listen(senderToken);

const ticketReuse = await fetch(`${base}/v1/connect?ticket=${a.ticket}`, {
  headers: { Upgrade: "websocket" },
});
expect("connect ticket is one-time", ticketReuse.status === 401);

const requestId = crypto.randomUUID();
const sent = await call("POST", "/v1/taps", senderToken, {
  requestId,
  body: "Laundry!",
});
expect(
  "send tap",
  sent.status === 201 && sent.json.state === "pending",
  sent.json
);
const tap = sent.json as Tap;

const retry = await call("POST", "/v1/taps", senderToken, {
  requestId,
  body: "Laundry!",
});
expect("idempotent retry returns same tap", retry.json.id === tap.id);

const conflict = await call("POST", "/v1/taps", senderToken, {
  requestId,
  body: "Other",
});
expect("reused request id with new body conflicts", conflict.status === 409);

const deviceCannotSend = await call("POST", "/v1/taps", deviceToken, {
  requestId: crypto.randomUUID(),
  body: "hi",
});
expect("device cannot send", deviceCannotSend.status === 401);

await settle();
expect(
  "both Macs and sender receive tap event",
  [a, b, s].every((l) =>
    l.events.some((e) => e.type === "tap" && e.tap.id === tap.id)
  )
);

const displayed = await call(
  "POST",
  `/v1/taps/${tap.id}/displayed`,
  deviceToken
);
expect("mark displayed", displayed.json.displayedAt !== null);

const [ackA, ackB] = await Promise.all([
  call("POST", `/v1/taps/${tap.id}/acknowledge`, deviceToken, {
    response: { kind: "on_it" },
  }),
  call("POST", `/v1/taps/${tap.id}/acknowledge`, macB.json.token, {
    response: { kind: "text", text: "late" },
  }),
]);
expect(
  "concurrent acks commit one response",
  ackA.json.state === "acknowledged" &&
    JSON.stringify(ackA.json.response) === JSON.stringify(ackB.json.response),
  [ackA.json, ackB.json]
);

await settle();
const last = (events: ServerEvent[]) =>
  events.filter((e) => e.type === "tap").at(-1);
expect(
  "every client sees acknowledgement",
  [a, b, s].every((l) => {
    const event = last(l.events);
    return event?.type === "tap" && event.tap.state === "acknowledged";
  })
);

const senderView = await call("GET", "/v1/me", senderToken);
expect(
  "sender snapshot has response",
  senderView.json.kind === "sender" &&
    senderView.json.taps[0]?.response !== null,
  senderView.json
);

const macView = await call("GET", "/v1/me", deviceToken);
expect(
  "mac snapshot lists 3 pairings",
  macView.json.credentials.length === 3,
  macView.json
);

const revoked = await call(
  "DELETE",
  `/v1/credentials/${sender.json.credentialId}`,
  deviceToken
);
expect("revoke sender", revoked.status === 200);
await settle();
expect(
  "revoked sender told over socket",
  s.events.some((e) => e.type === "revoked")
);
const afterRevoke = await call("POST", "/v1/taps", senderToken, {
  requestId: crypto.randomUUID(),
  body: "still here?",
});
expect("revoked sender cannot send", afterRevoke.status === 401);

for (const l of [a, b, s]) {
  l.socket.close();
}
console.log("All checks passed");
