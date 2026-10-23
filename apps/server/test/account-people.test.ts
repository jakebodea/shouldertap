import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

import { Conflict, Expired, NotFound, Unauthorized } from "@shouldertap/domain";
import type { ParsedToken, PersonColor } from "@shouldertap/domain";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invitePreview, peopleAction } from "../src/account-people";
import type { AnalyticsEvent } from "../src/analytics";
import type { InboxRpc } from "../src/Inbox";

/**
 * Real SQLite stands in for D1. Inbox objects are another process reached over
 * RPC, so they're faked at that boundary: a minimal in-memory model of the
 * credentials and invites each one holds.
 */
const migrations = [
  "0002_identity",
  "0003_billing_target",
  "0004_account_operation",
  "0005_adoption_operation",
  "0006_profile",
];

interface FakeCredential {
  id: string;
  kind: "device" | "sender";
  name: string;
  color: PersonColor | null;
  parentId: string | null;
  revoked: boolean;
}
interface FakeInbox {
  recipientName: string;
  credentials: Map<string, FakeCredential>;
  invites: Map<string, { used: boolean }>;
  senderRoom: number;
}

let sqlite: DatabaseSync;
let db: D1Database;
let world: Map<string, FakeInbox>;
let counter: number;
/** What would have gone to PostHog, an external service. */
let tracked: AnalyticsEvent[];

const nextId = (prefix: string) => {
  counter += 1;
  return `${prefix}${String(counter).padStart(8, "0")}`;
};
const token = (inboxId: string, id: string) => `${inboxId}.${id}.secret${id}`;

const fakeInbox = (inboxId: string): InboxRpc => {
  const state = () => world.get(inboxId);
  const live = (id: string) => {
    const credential = state()?.credentials.get(id);
    return credential && !credential.revoked ? credential : undefined;
  };
  const rpc: Partial<InboxRpc> = {
    identify: (parsed: ParsedToken) => {
      let credential = live(parsed.id);
      if (credential?.parentId) {
        credential = live(credential.parentId);
      }
      return credential
        ? Effect.succeed({
            kind: credential.kind,
            credentialId: credential.id,
            recipientName: state()?.recipientName ?? "",
          })
        : Effect.fail(
            new Unauthorized({ message: "This pairing is no longer valid" })
          );
    },
    initializeForAccount: (id: string, recipientName: string) => {
      if (world.has(id)) {
        return Effect.succeed({ created: false });
      }
      world.set(id, {
        recipientName,
        credentials: new Map(),
        invites: new Map(),
        senderRoom: 20,
      });
      return Effect.succeed({ created: true });
    },
    rename: (_id: string, recipientName: string) => {
      const inbox = state();
      if (inbox) {
        inbox.recipientName = recipientName;
      }
      return Effect.void;
    },
    addAccountSender: (_id: string, name: string, color: PersonColor) => {
      const inbox = state();
      if (!inbox || inbox.senderRoom <= 0) {
        return Effect.fail(new Conflict({ message: "Full" }));
      }
      inbox.senderRoom -= 1;
      const id = nextId("s");
      inbox.credentials.set(id, {
        id,
        kind: "sender",
        name,
        color,
        parentId: null,
        revoked: false,
      });
      return Effect.succeed({ credentialId: id });
    },
    removeAccountSender: (credentialId: string) =>
      Effect.sync(() => {
        const credential = live(credentialId);
        if (credential) {
          credential.revoked = true;
        }
      }),
    accountInvite: (id: string) => {
      const code = nextId("i");
      state()?.invites.set(code, { used: false });
      return Effect.succeed({
        kind: "sender" as const,
        code: token(id, code),
        expiresAt: 0,
      });
    },
    previewInvite: (parsed: ParsedToken) => {
      const invite = state()?.invites.get(parsed.id);
      if (!invite) {
        return Effect.fail(
          new NotFound({ message: "This invite link isn't valid" })
        );
      }
      return invite.used
        ? Effect.fail(
            new Expired({ message: "This invite link was already used" })
          )
        : Effect.succeed({
            recipientName: state()?.recipientName ?? "",
            expiresAt: 1_800_000_000_000,
          });
    },
    redeemInvite: (parsed: ParsedToken, request) => {
      const inbox = state();
      const invite = inbox?.invites.get(parsed.id);
      if (!inbox || !invite || invite.used) {
        return Effect.fail(
          new NotFound({ message: "This invite link isn't valid" })
        );
      }
      if (inbox.senderRoom <= 0) {
        return Effect.fail(new Conflict({ message: "Full" }));
      }
      invite.used = true;
      inbox.senderRoom -= 1;
      const id = nextId("s");
      inbox.credentials.set(id, {
        id,
        kind: "sender",
        name: request.name,
        color: request.color ?? null,
        parentId: null,
        revoked: false,
      });
      return Effect.succeed({
        kind: "sender" as const,
        credentialId: id,
        token: token(inboxId, id),
        recipientName: inbox.recipientName,
      });
    },
    accountRestore: (_id: string, senderId: string | null, name: string) => {
      const inbox = state();
      if (!inbox || (senderId && !live(senderId))) {
        return Effect.fail(
          new Unauthorized({ message: "This sender was removed" })
        );
      }
      const id = nextId(senderId ? "k" : "d");
      inbox.credentials.set(id, {
        id,
        kind: senderId ? "sender" : "device",
        name,
        color: null,
        parentId: senderId,
        revoked: false,
      });
      return Effect.succeed({
        kind: senderId ? ("sender" as const) : ("device" as const),
        credentialId: senderId ?? id,
        token: token(inboxId, id),
        recipientName: inbox.recipientName,
      });
    },
  };
  return rpc as InboxRpc;
};

const deps = () => ({
  db,
  inboxes: { getByName: fakeInbox },
  track: (event: AnalyticsEvent) =>
    Effect.sync(() => {
      tracked.push(event);
    }),
});

const act = <A = Record<string, unknown>>(
  userId: string,
  action: string,
  body: object = {}
) => {
  const effect = peopleAction(deps(), userId, action, body);
  if (!effect) {
    throw new Error(`No action ${action}`);
  }
  return Effect.runPromise(effect as Effect.Effect<A, unknown>);
};
const fails = (userId: string, action: string, body: object = {}) => {
  const effect = peopleAction(deps(), userId, action, body);
  if (!effect) {
    throw new Error(`No action ${action}`);
  }
  return Effect.runPromise(
    (
      effect as unknown as Effect.Effect<
        unknown,
        { _tag: string; message: string }
      >
    ).pipe(Effect.flip)
  );
};
const phone = { platform: "iphone", deviceName: "Sam's iPhone" };

interface SyncResult {
  inbox: { kind: string; recipientName: string } | null;
  senders: { id: string; name: string; grant: { recipientName: string } }[];
  removed: string[];
}

const connect = async () => {
  await act("ari", "profile", { name: "Ari", color: "moss" });
  await act("sam", "profile", { name: "Sam", color: "tomato" });
  const invite = await act<{ code: string }>("ari", "invite");
  const preview = await Effect.runPromise(
    invitePreview(deps(), invite.code) as Effect.Effect<unknown, unknown>
  );
  const accepted = await act<{
    person: object;
    mutual: boolean;
    sender: { id: string; name: string; grant: { recipientName: string } };
  }>("sam", "accept", { ...phone, code: invite.code });
  return { invite, preview, accepted };
};
describe("account people", () => {
  beforeEach(() => {
    counter = 0;
    tracked = [];
    world = new Map();
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      "CREATE TABLE user(id TEXT PRIMARY KEY, email TEXT); INSERT INTO user VALUES('sam','sam@example.com'),('ari','ari@example.com'),('jo','jo@example.com'); PRAGMA foreign_keys=ON;"
    );
    for (const name of migrations) {
      sqlite.exec(
        readFileSync(
          new URL(`../account-migrations/${name}.sql`, import.meta.url),
          "utf-8"
        )
      );
    }
    db = {
      prepare: (sql: string) => ({
        bind: (...args: never[]) => ({
          all: () =>
            Promise.resolve({ results: sqlite.prepare(sql).all(...args) }),
          first: () =>
            Promise.resolve(sqlite.prepare(sql).get(...args) ?? null),
          run: () => Promise.resolve(sqlite.prepare(sql).run(...args)),
        }),
      }),
    } as unknown as D1Database;
  });
  afterEach(() => sqlite.close());

  describe("account-first profile", () => {
    it("asks a new account for a name before anything else", async () => {
      await expect(act("sam", "me")).resolves.toStrictEqual({
        email: "sam@example.com",
        profile: null,
        suggestedName: null,
        inboxId: null,
      });
      const refused = await fails("sam", "sync", { ...phone, receive: true });
      expect(refused.message).toBe("Choose your name first");
    });

    it("creates one inbox however many times the profile is saved", async () => {
      const first = await act<{ inboxId: string }>("sam", "profile", {
        name: " Sam ",
        color: "tomato",
      });
      const second = await act<{ inboxId: string; profile: object }>(
        "sam",
        "profile",
        { name: "Samantha", color: "moss" }
      );
      expect(second.inboxId).toBe(first.inboxId);
      expect(second.profile).toStrictEqual({ name: "Samantha", color: "moss" });
      expect(world.size).toBe(1);
      expect(world.get(first.inboxId)?.recipientName).toBe("Samantha");
    });

    it("reports each new inbox and accepted invite once", async () => {
      await connect();
      await act("sam", "profile", { name: "Samantha", color: "moss" });
      expect(tracked).toStrictEqual([
        {
          name: "inbox_created",
          inboxId: "6d74c226099a0e0f55a4ecf3aaa81725",
          userId: "ari",
          platform: null,
        },
        {
          name: "inbox_created",
          inboxId: "5e29bc970b8f9f597065a1ce313694a9",
          userId: "sam",
          platform: null,
        },
        {
          name: "invite_redeemed",
          inboxId: "6d74c226099a0e0f55a4ecf3aaa81725",
          credentialId: "s00000003",
          kind: "sender",
          userId: "sam",
          platform: null,
        },
      ]);
    });

    it("rejects an empty name and an unknown color", async () => {
      const blank = await fails("sam", "profile", {
        name: "  ",
        color: "moss",
      });
      const color = await fails("sam", "profile", {
        name: "Sam",
        color: "teal",
      });
      expect(blank.message).toBe("Enter a name up to 40 characters");
      expect(color.message).toBe("Choose a color");
    });
  });

  describe("signing in links a device", () => {
    it("gives a receiving device your inbox once, and the browser none", async () => {
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const iphone = await act<SyncResult>("sam", "sync", {
        ...phone,
        receive: true,
      });
      const browser = await act<SyncResult>("sam", "sync", {
        platform: "web",
        deviceName: "Safari",
        receive: true,
      });
      expect(iphone.inbox).toMatchObject({
        kind: "device",
        recipientName: "Sam",
      });
      expect(browser.inbox).toBeNull();
    });

    it("doesn't issue another inbox key to a device that holds one", async () => {
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const first = await act<SyncResult & { inbox: { token: string } }>(
        "sam",
        "sync",
        { ...phone, receive: true }
      );
      const again = await act<SyncResult>("sam", "sync", {
        ...phone,
        receive: true,
        tokens: [first.inbox.token],
      });
      expect(again.inbox).toBeNull();
    });

    it("keeps an existing user's inbox and offers its name", async () => {
      world.set("legacyinbox", {
        recipientName: "Old Sam",
        credentials: new Map([
          [
            "device01",
            {
              id: "device01",
              kind: "device",
              name: "Mac",
              color: null,
              parentId: null,
              revoked: false,
            },
          ],
        ]),
        invites: new Map(),
        senderRoom: 20,
      });
      sqlite.exec(
        "INSERT INTO account_resource VALUES('inbox','legacyinbox','sam','legacyinbox',NULL,'Old Sam',1)"
      );
      const me = await act<{ suggestedName: string }>("sam", "me");
      const saved = await act<{ inboxId: string }>("sam", "profile", {
        name: "Sam",
        color: "sky",
      });
      const synced = await act<SyncResult>("sam", "sync", {
        ...phone,
        receive: true,
        tokens: [token("legacyinbox", "device01")],
      });
      expect(me.suggestedName).toBe("Old Sam");
      expect(saved.inboxId).toBe("legacyinbox");
      expect(synced.inbox).toBeNull();
      expect(world.size).toBe(1);
    });

    it("tells the device to drop a token whose connection is gone", async () => {
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const synced = await act<SyncResult>("sam", "sync", {
        ...phone,
        receive: false,
        tokens: ["nowhereinbox.goneforgood.secretvalue", "not a token"],
      });
      expect(synced.removed).toStrictEqual([
        "nowhereinbox.goneforgood.secretvalue",
        "not a token",
      ]);
    });
  });

  describe("accepting an invite connects both people", () => {
    it("shows who it's from in their own color", async () => {
      const { preview } = await connect();
      expect(preview).toStrictEqual({
        name: "Ari",
        color: "moss",
        expiresAt: 1_800_000_000_000,
      });
    });

    it("lets the invited person tap the inviter, in their own name and color", async () => {
      const { accepted } = await connect();
      expect(accepted.person).toStrictEqual({ name: "Ari", color: "moss" });
      expect(accepted.mutual).toBeTruthy();
      expect(accepted.sender).toMatchObject({
        name: "Sam",
        color: "tomato",
        grant: { kind: "sender", recipientName: "Ari" },
      });
    });

    it("lets the inviter tap back from every device they sign in on", async () => {
      await connect();
      const ariPhone = await act<SyncResult>("ari", "sync", {
        platform: "iphone",
        deviceName: "Ari's iPhone",
        receive: true,
      });
      const ariMac = await act<SyncResult>("ari", "sync", {
        platform: "mac",
        deviceName: "Ari's Mac",
        receive: true,
      });
      expect(
        ariPhone.senders.map((s) => [s.name, s.grant.recipientName])
      ).toStrictEqual([["Ari", "Sam"]]);
      expect(ariMac.senders.map((s) => s.grant.recipientName)).toStrictEqual([
        "Sam",
      ]);
    });

    it("gives the accepting person's other devices their key too", async () => {
      await connect();
      const samMac = await act<SyncResult>("sam", "sync", {
        platform: "mac",
        deviceName: "Sam's Mac",
        receive: true,
      });
      expect(samMac.senders.map((s) => s.grant.recipientName)).toStrictEqual([
        "Ari",
      ]);
    });

    it("refuses your own invite", async () => {
      await act("ari", "profile", { name: "Ari", color: "moss" });
      const invite = await act<{ code: string }>("ari", "invite");
      const refused = await fails("ari", "accept", {
        ...phone,
        code: invite.code,
      });
      expect(refused.message).toBe("That's your own invite");
    });

    it("undoes the half it made when the inviter's inbox is full", async () => {
      await act("ari", "profile", { name: "Ari", color: "moss" });
      const sam = await act<{ inboxId: string }>("sam", "profile", {
        name: "Sam",
        color: "tomato",
      });
      const invite = await act<{ code: string }>("ari", "invite");
      const ari = await act<{ inboxId: string }>("ari", "me");
      const full = world.get(ari.inboxId);
      if (full) {
        full.senderRoom = 0;
      }
      const refused = await fails("sam", "accept", {
        ...phone,
        code: invite.code,
      });
      const left = [...(world.get(sam.inboxId)?.credentials.values() ?? [])];
      expect(refused._tag).toBe("Conflict");
      expect(left.map((c) => c.revoked)).toStrictEqual([true]);
    });

    it("connects one way to an inviter who has no account", async () => {
      world.set("legacyinbox", {
        recipientName: "Jo",
        credentials: new Map(),
        invites: new Map([["oldinvite", { used: false }]]),
        senderRoom: 20,
      });
      const sam = await act<{ inboxId: string }>("sam", "profile", {
        name: "Sam",
        color: "tomato",
      });
      const accepted = await act<{ person: object; mutual: boolean }>(
        "sam",
        "accept",
        { ...phone, code: token("legacyinbox", "oldinvite") }
      );
      expect(accepted.person).toStrictEqual({ name: "Jo", color: null });
      expect(accepted.mutual).toBeFalsy();
      expect(world.get(sam.inboxId)?.credentials.size).toBe(0);
    });
  });
  describe("removing someone you tap", () => {
    it("keeps them off every device, while they can still tap you", async () => {
      const { accepted } = await connect();
      const removed = await act("sam", "remove", { id: accepted.sender.id });
      const samMac = await act<SyncResult>("sam", "sync", {
        platform: "mac",
        deviceName: "Sam's Mac",
        receive: true,
      });
      const ariPhone = await act<SyncResult>("ari", "sync", {
        platform: "iphone",
        deviceName: "Ari's iPhone",
        receive: true,
      });
      expect(removed).toStrictEqual({ removed: true });
      expect(samMac.senders.map((s) => s.grant.recipientName)).toStrictEqual(
        []
      );
      expect(ariPhone.senders.map((s) => s.grant.recipientName)).toStrictEqual([
        "Sam",
      ]);
    });

    it("can't remove a connection another account owns", async () => {
      const { accepted } = await connect();
      const refused = await fails("ari", "remove", { id: accepted.sender.id });
      expect(refused.message).toBe("No such person");
    });
  });
});
