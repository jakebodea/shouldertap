import { expect } from "bun:test";
import { makeShouldertapClient } from "@shouldertap/client";
import { ServerEvent, type Tap } from "@shouldertap/domain";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import Stack from "../../../alchemy.run.ts";

/**
 * Deploys the whole Stack once (to the `test_$USER` stage, or locally with
 * `ALCHEMY_DEV=1`) and drives the public protocol end to end.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

// STACK_URL=<server url> runs the suite against an existing deployment.
const existing = process.env.STACK_URL;
const stack = beforeAll(
  existing ? Effect.succeed({ server: existing }) : deploy(Stack),
  {
    timeout: 300_000,
  }
);
afterAll.skipIf(!!existing || !!process.env.NO_DESTROY)(destroy(Stack));

const HTTP_SCHEME = /^http/;
const decodeEvent = Schema.decodeUnknownSync(ServerEvent);

const client = (url: string, token: string | null = null) =>
  makeShouldertapClient(url, token);

/** A Mac, a second Mac and a sender, paired to a fresh inbox. */
const pairedInbox = Effect.fn(function* (url: string) {
  const anon = yield* client(url);
  const macA = yield* anon.pairing.createInbox({
    payload: { recipientName: "Jake", deviceName: "Studio Mac" },
  });
  const mac = yield* client(url, macA.token);
  const senderInvite = yield* mac.inbox.createInvite({
    payload: { kind: "sender" },
  });
  const sender = yield* anon.pairing.redeemInvite({
    payload: { code: senderInvite.code, name: "Sam", color: "moss" },
  });
  const deviceInvite = yield* mac.inbox.createInvite({
    payload: { kind: "device" },
  });
  const macB = yield* anon.pairing.redeemInvite({
    payload: { code: deviceInvite.code, name: "Laptop" },
  });
  return { anon, macA, macB, sender, senderInvite };
});

/** Opens a live connection and collects decoded events into a queue. */
const listen = Effect.fn(function* (url: string, token: string) {
  const { ticket } = yield* (yield* client(url, token)).inbox.connectTicket();
  const events = yield* Queue.unbounded<ServerEvent>();
  yield* Effect.acquireRelease(
    Effect.callback<WebSocket, Error>((resume) => {
      const socket = new WebSocket(
        `${url.replace(HTTP_SCHEME, "ws")}/v1/connect?ticket=${encodeURIComponent(ticket)}`
      );
      socket.addEventListener("message", (message) => {
        if (message.data !== "pong") {
          Effect.runFork(
            Queue.offer(events, decodeEvent(JSON.parse(String(message.data))))
          );
        }
      });
      socket.addEventListener("open", () => resume(Effect.succeed(socket)));
      socket.addEventListener("error", () =>
        resume(Effect.fail(new Error("WebSocket failed")))
      );
    }),
    (socket) => Effect.sync(() => socket.close())
  );
  const next = (match: (event: ServerEvent) => boolean) =>
    Queue.take(events).pipe(
      Effect.repeat({ until: match }),
      Effect.timeout("10 seconds")
    );
  return { next, ticket };
});

const tapEvent = (id: string, state?: Tap["state"]) => (event: ServerEvent) =>
  event.type === "tap" &&
  event.tap.id === id &&
  (state === undefined || event.tap.state === state);

test(
  "pairs devices and senders with one-time invites",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    yield* Test.getWhenReady(url);
    const { anon, macA, macB, sender, senderInvite } = yield* pairedInbox(url);
    expect(sender.kind).toBe("sender");
    expect(macB.kind).toBe("device");

    const reused = yield* anon.pairing
      .redeemInvite({ payload: { code: senderInvite.code, name: "Eve" } })
      .pipe(Effect.flip);
    expect(reused._tag).toBe("Expired");

    const senderCannotInvite = yield* (yield* client(url, sender.token)).inbox
      .createInvite({ payload: { kind: "sender" } })
      .pipe(Effect.flip);
    expect(senderCannotInvite._tag).toBe("Unauthorized");

    const snapshot = yield* (yield* client(url, macA.token)).inbox.me();
    expect(snapshot.kind === "device" && snapshot.credentials.length).toBe(3);
    const colors =
      snapshot.kind === "device"
        ? snapshot.credentials.map((c) => [c.kind, c.color])
        : [];
    expect(colors).toContainEqual(["sender", "moss"]);
    expect(colors).toContainEqual(["device", null]);
  }),
  { timeout: 60_000 }
);

test(
  "delivers a tap live, first acknowledgement wins, everyone sees it",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const { macA, macB, sender } = yield* pairedInbox(url);
    const a = yield* listen(url, macA.token);
    const b = yield* listen(url, macB.token);
    const s = yield* listen(url, sender.token);
    const senderApi = yield* client(url, sender.token);
    const macApi = yield* client(url, macA.token);
    const laptopApi = yield* client(url, macB.token);

    const requestId = crypto.randomUUID();
    const tap = yield* senderApi.inbox.sendTap({
      payload: { requestId, body: "Laundry!" },
    });
    expect(tap.state).toBe("pending");
    expect(tap.senderColor).toBe("moss");

    const retry = yield* senderApi.inbox.sendTap({
      payload: { requestId, body: "Laundry!" },
    });
    expect(retry.id).toBe(tap.id);
    const conflict = yield* senderApi.inbox
      .sendTap({ payload: { requestId, body: "Something else" } })
      .pipe(Effect.flip);
    expect(conflict._tag).toBe("Conflict");
    const macCannotSend = yield* macApi.inbox
      .sendTap({ payload: { requestId: crypto.randomUUID(), body: "hi" } })
      .pipe(Effect.flip);
    expect(macCannotSend._tag).toBe("Unauthorized");

    yield* Effect.all([
      a.next(tapEvent(tap.id)),
      b.next(tapEvent(tap.id)),
      s.next(tapEvent(tap.id)),
    ]);

    const displayed = yield* macApi.inbox.markDisplayed({
      params: { id: tap.id },
    });
    expect(displayed.displayedAt).not.toBeNull();

    const [ackA, ackB] = yield* Effect.all(
      [
        macApi.inbox.acknowledge({
          params: { id: tap.id },
          payload: { response: { kind: "on_it" } },
        }),
        laptopApi.inbox.acknowledge({
          params: { id: tap.id },
          payload: { response: { kind: "text", text: "late" } },
        }),
      ],
      { concurrency: "unbounded" }
    );
    expect(ackA.state).toBe("acknowledged");
    expect(ackA.response).toEqual(ackB.response);

    yield* Effect.all([
      a.next(tapEvent(tap.id, "acknowledged")),
      b.next(tapEvent(tap.id, "acknowledged")),
      s.next(tapEvent(tap.id, "acknowledged")),
    ]);

    const senderView = yield* senderApi.inbox.me();
    expect(senderView.taps[0]?.response).not.toBeNull();
  }).pipe(Effect.scoped),
  { timeout: 60_000 }
);

test(
  "connect tickets are one-time and revocation disconnects",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const { macA, sender } = yield* pairedInbox(url);
    const s = yield* listen(url, sender.token);

    const reuseOpened = yield* Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = new WebSocket(
            `${url.replace(HTTP_SCHEME, "ws")}/v1/connect?ticket=${encodeURIComponent(s.ticket)}`
          );
          socket.addEventListener("open", () => {
            socket.close();
            resolve(true);
          });
          socket.addEventListener("error", () => resolve(false));
          socket.addEventListener("close", () => resolve(false));
        })
    );
    expect(reuseOpened).toBe(false);

    yield* (yield* client(url, macA.token)).inbox.revoke({
      params: { id: sender.credentialId },
    });
    yield* s.next((event) => event.type === "revoked");

    const afterRevoke = yield* (yield* client(url, sender.token)).inbox
      .sendTap({
        payload: { requestId: crypto.randomUUID(), body: "still here?" },
      })
      .pipe(Effect.flip);
    expect(afterRevoke._tag).toBe("Unauthorized");
  }).pipe(Effect.scoped),
  { timeout: 60_000 }
);

// Runs last: it exhausts this IP's inbox-creation budget for the next minute.
test(
  "rate-limits inbox creation per client",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const anon = yield* client(url);
    const create = anon.pairing
      .createInbox({
        payload: { recipientName: "Flood", deviceName: "Script" },
      })
      .pipe(
        Effect.as("created" as const),
        Effect.catchTag("TooManyRequests", () =>
          Effect.succeed("limited" as const)
        )
      );
    const results = yield* Effect.all(Array.from({ length: 15 }, () => create));
    expect(results).toContain("limited");
  }),
  { timeout: 60_000 }
);
