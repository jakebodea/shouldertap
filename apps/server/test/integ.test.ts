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

    // A new inbox starts a 7-day trial.
    const plan = snapshot.kind === "device" ? snapshot.plan : null;
    expect(plan?.status).toBe("trial");
    const trialDays = ((plan?.trialEndsAt ?? 0) - Date.now()) / 86_400_000;
    expect(trialDays).toBeGreaterThan(6.9);
    expect(trialDays).toBeLessThanOrEqual(7);

    // A trial delivers taps; expiry (402) is covered by test/plan.test.ts,
    // since no public API can end a trial early.
    const trialTap = yield* (yield* client(url, sender.token)).inbox.sendTap({
      payload: { requestId: crypto.randomUUID(), body: "Trial tap" },
    });
    expect(trialTap.state).toBe("pending");

    // Only a Mac can start a checkout; test stacks have no Creem keys.
    const senderCheckout = yield* (yield* client(url, sender.token)).inbox
      .createCheckout()
      .pipe(Effect.flip);
    expect(senderCheckout._tag).toBe("Unauthorized");
    const checkout = yield* (yield* client(url, macA.token)).inbox
      .createCheckout()
      .pipe(Effect.flip);
    expect(checkout._tag).toBe("Unavailable");
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

test(
  "a sender can unpair itself, and only itself",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const { anon, macA, sender } = yield* pairedInbox(url);
    const mac = yield* client(url, macA.token);
    const senderApi = yield* client(url, sender.token);

    // Another sender's credential, or a Mac's, is off limits.
    const { code } = yield* mac.inbox.createInvite({
      payload: { kind: "sender" },
    });
    const other = yield* anon.pairing.redeemInvite({
      payload: { code, name: "Other" },
    });
    for (const id of [other.credentialId, macA.credentialId]) {
      const denied = yield* senderApi.inbox
        .revoke({ params: { id } })
        .pipe(Effect.flip);
      expect(denied._tag).toBe("Unauthorized");
    }

    const a = yield* listen(url, macA.token);
    yield* senderApi.inbox.revoke({ params: { id: sender.credentialId } });
    yield* a.next((event) => event.type === "credentials");
    const snapshot = yield* mac.inbox.me();
    expect(snapshot.kind).toBe("device");
    if (snapshot.kind === "device") {
      const ids = snapshot.credentials.map((c) => c.id);
      expect(ids).not.toContain(sender.credentialId);
      expect(ids).toContain(other.credentialId);
    }
  }).pipe(Effect.scoped),
  { timeout: 60_000 }
);

test(
  "limits each sender to 30 taps an hour, retries still succeed",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const { sender } = yield* pairedInbox(url);
    const senderApi = yield* client(url, sender.token);
    const send = (requestId: string, body: string) =>
      senderApi.inbox.sendTap({ payload: { requestId, body } });

    const requestIds = Array.from({ length: 30 }, () => crypto.randomUUID());
    const sent = yield* Effect.forEach(requestIds, (requestId, i) =>
      send(requestId, `tap ${i}`)
    );
    const limited = yield* send(crypto.randomUUID(), "one more").pipe(
      Effect.flip
    );
    expect(limited._tag).toBe("TooManyRequests");
    expect(limited.message).toContain("this hour");

    // An idempotent retry of an accepted tap isn't a new tap.
    const retry = yield* send(requestIds[0] as string, "tap 0");
    expect(retry.id).toBe((sent[0] as Tap).id);
  }),
  { timeout: 60_000 }
);

test(
  "caps an inbox at 20 senders and 10 Macs",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const { anon, macA } = yield* pairedInbox(url);
    const mac = yield* client(url, macA.token);
    const invite = (kind: "sender" | "device") =>
      mac.inbox.createInvite({ payload: { kind } });
    const redeem = (code: string, name: string) =>
      anon.pairing.redeemInvite({ payload: { code, name } });

    // pairedInbox has 1 sender and 2 Macs. Fill senders to 19.
    yield* Effect.forEach(
      Array.from({ length: 18 }, (_, i) => i),
      (i) =>
        invite("sender").pipe(
          Effect.flatMap(({ code }) => redeem(code, `Sender ${i}`))
        )
    );
    // Two invites made at 19; the second can't be redeemed at 20…
    const last = yield* invite("sender");
    const spare = yield* invite("sender");
    const twentieth = yield* redeem(last.code, "Twentieth");
    const full = yield* redeem(spare.code, "Too many").pipe(Effect.flip);
    expect(full._tag).toBe("Conflict");
    expect(full.message).toContain("20");
    const fullInvite = yield* invite("sender").pipe(Effect.flip);
    expect(fullInvite._tag).toBe("Conflict");

    // …but isn't used up: removing someone makes room for the same link.
    yield* mac.inbox.revoke({ params: { id: twentieth.credentialId } });
    const later = yield* redeem(spare.code, "Later");
    expect(later.kind).toBe("sender");

    // Macs: 2 paired, fill to 10.
    yield* Effect.forEach(
      Array.from({ length: 8 }, (_, i) => i),
      (i) =>
        invite("device").pipe(
          Effect.flatMap(({ code }) => redeem(code, `Mac ${i}`))
        )
    );
    const tooManyMacs = yield* invite("device").pipe(Effect.flip);
    expect(tooManyMacs._tag).toBe("Conflict");
    expect(tooManyMacs.message).toContain("10 Macs");
    expect(fullInvite.message).toContain("Remove someone");
  }),
  { timeout: 120_000 }
);

test(
  "a Mac keeps its first trial when it sets up again",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const anon = yield* client(url);
    // Random per run, so reruns against a long-lived stack start fresh.
    const fingerprint = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    const trialEndsAt = Effect.fn(function* (fromMachine: string) {
      const grant = yield* anon.pairing.createInbox({
        payload: {
          recipientName: "Jake",
          deviceName: "Studio Mac",
          machine: fromMachine,
        },
      });
      const snapshot = yield* (yield* client(url, grant.token)).inbox.me();
      return snapshot.kind === "device" ? snapshot.plan.trialEndsAt : 0;
    });

    const machine = fingerprint();
    const first = yield* trialEndsAt(machine);
    expect((first - Date.now()) / 86_400_000).toBeGreaterThan(6.9);
    // Unpairing and setting up again inherits the same trial end.
    expect(yield* trialEndsAt(machine)).toBe(first);
    // Another Mac gets its own trial.
    const other = yield* trialEndsAt(fingerprint());
    expect(other).toBeGreaterThanOrEqual(first);
    expect((other - Date.now()) / 86_400_000).toBeGreaterThan(6.9);

    // A malformed fingerprint is rejected before anything is created.
    for (const bad of ["A".repeat(64), "ab".repeat(16), "not hex"]) {
      const response = yield* Effect.promise(() =>
        fetch(`${url}/v1/inboxes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            recipientName: "Jake",
            deviceName: "Studio Mac",
            machine: bad,
          }),
        })
      );
      expect(response.status).toBe(400);
    }
  }),
  { timeout: 60_000 }
);

// Runs last: it exhausts this IP's inbox-creation budget for the next minute.
test(
  "sender deletion removes messages, invalidates access and preserves other senders",
  Effect.gen(function* () {
    const url = (yield* stack).server;
    const { anon, macA, sender } = yield* pairedInbox(url);
    const mac = yield* client(url, macA.token);
    const first = yield* client(url, sender.token);
    const invite = yield* mac.inbox.createInvite({
      payload: { kind: "sender" },
    });
    const other = yield* anon.pairing.redeemInvite({
      payload: { code: invite.code, name: "Other" },
    });
    const second = yield* client(url, other.token);
    const mine = yield* first.inbox.sendTap({
      payload: { requestId: crypto.randomUUID(), body: "Delete this message" },
    });
    yield* mac.inbox.acknowledge({
      params: { id: mine.id },
      payload: { response: { kind: "text", text: "Delete this reply too" } },
    });
    const keep = yield* second.inbox.sendTap({
      payload: { requestId: crypto.randomUUID(), body: "Keep this message" },
    });
    const macCannotDeleteSender = yield* mac.inbox
      .deleteSender()
      .pipe(Effect.flip);
    expect(macCannotDeleteSender._tag).toBe("Unauthorized");
    yield* first.inbox.deleteSender();
    const snapshot = yield* mac.inbox.me();
    expect(snapshot.taps.map((tap) => tap.id)).toContain(keep.id);
    expect(snapshot.taps.map((tap) => tap.id)).not.toContain(mine.id);
    expect(
      snapshot.kind === "device" &&
        snapshot.credentials.some(
          (credential) => credential.id === sender.credentialId
        )
    ).toBe(false);
    const access = yield* first.inbox.me().pipe(Effect.flip);
    expect(access._tag).toBe("Unauthorized");
    const blocked = yield* second.inbox
      .sendTap({
        payload: { requestId: crypto.randomUUID(), body: "I will kill you" },
      })
      .pipe(Effect.flip);
    expect(blocked._tag).toBe("InvalidRequest");
    const blockedReply = yield* mac.inbox
      .acknowledge({
        params: { id: keep.id },
        payload: { response: { kind: "text", text: "kill yourself" } },
      })
      .pipe(Effect.flip);
    expect(blockedReply._tag).toBe("InvalidRequest");
    const own = yield* second.inbox.me();
    expect(own.taps).toHaveLength(1);
    expect(own.taps[0]?.state).toBe("pending");
  })
);

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
