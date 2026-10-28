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
  "0007_send_profile",
  "0008_quick_replies",
  "0009_send_theme",
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
  /** Who sent each tap waiting here, by person-level sender id. */
  taps?: { senderId: string; body: string }[];
}

let sqlite: DatabaseSync;
let db: D1Database;
let world: Map<string, FakeInbox>;
let counter: number;
/** What would have gone to PostHog, an external service. */
let tracked: AnalyticsEvent[];
/** Runs when an inbox has redeemed an invite and tells its devices, as the
 * real one does by broadcasting `credentials`. */
let onRedeemed: (() => Promise<void>) | null;

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
    updateAccountSender: (
      credentialId: string,
      name: string,
      color: PersonColor
    ) => {
      const credential = live(credentialId);
      if (!credential) {
        return Effect.fail(
          new Unauthorized({ message: "This sender was removed" })
        );
      }
      credential.name = name;
      credential.color = color;
      return Effect.void;
    },
    removeAccountSender: (credentialId: string) =>
      Effect.sync(() => {
        const credential = live(credentialId);
        if (credential) {
          credential.revoked = true;
        }
      }),
    deleteAccountSender: (credentialId: string) =>
      Effect.sync(() => {
        const inbox = state();
        if (!inbox) {
          return;
        }
        for (const [id, credential] of inbox.credentials) {
          if (id === credentialId || credential.parentId === credentialId) {
            inbox.credentials.delete(id);
          }
        }
        inbox.taps = (inbox.taps ?? []).filter(
          (tap) => tap.senderId !== credentialId
        );
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
      const grant = {
        kind: "sender" as const,
        credentialId: id,
        token: token(inboxId, id),
        recipientName: inbox.recipientName,
      };
      return Effect.promise(async () => {
        await onRedeemed?.();
        return grant;
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
  senders: {
    id: string;
    name: string;
    color: string;
    theme: string | null;
    chooseSeenAs: boolean;
    grant: { recipientName: string; token: string };
  }[];
  removed: string[];
  connections: {
    id: string;
    name: string;
    color: string;
    theme: string | null;
    chooseSeenAs: boolean;
  }[];
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
    sender: {
      id: string;
      name: string;
      grant: { recipientName: string; token: string };
    };
  }>("sam", "accept", { ...phone, code: invite.code });
  return { invite, preview, accepted };
};
/** How `viewer`'s inbox shows the person tapping it. */
const seenBy = async (viewer: string) => {
  const me = await act<{ inboxId: string }>(viewer, "me");
  return [...(world.get(me.inboxId)?.credentials.values() ?? [])]
    .filter((c) => c.kind === "sender" && !c.parentId && !c.revoked)
    .map((c) => [c.name, c.color]);
};
const inviteFrom = async (from: string) => {
  const created = await act<{ code: string }>(from, "invite");
  return created.code;
};
/** A tap from `senderId` waiting in Ari's inbox; reads back what's left. */
const tapAtAri = async (senderId: string) => {
  const ari = await act<{ inboxId: string }>("ari", "me");
  const inbox = world.get(ari.inboxId);
  if (inbox) {
    inbox.taps = [{ senderId, body: "Lunch?" }];
  }
  return () => world.get(ari.inboxId)?.taps?.map((t) => t.body);
};
describe("account people", () => {
  beforeEach(() => {
    counter = 0;
    tracked = [];
    onRedeemed = null;
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
        sendProfile: null,
        suggestedName: null,
        inboxId: null,
        quickReplies: null,
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

  describe("default quick replies", () => {
    it("are kept on the account, tidied, until set back to On it and In 10 min", async () => {
      const saved = await act<{ quickReplies: unknown }>(
        "sam",
        "quick-replies",
        { replies: [" Coming! ", "Can't now"] }
      );
      expect(saved.quickReplies).toStrictEqual(["Coming!", "Can't now"]);
      const me = await act<{ quickReplies: unknown }>("sam", "me");
      expect(me.quickReplies).toStrictEqual(["Coming!", "Can't now"]);
      const presets = await act<{ quickReplies: unknown }>(
        "sam",
        "quick-replies",
        { replies: ["On it", "In 10 min"] }
      );
      expect(presets.quickReplies).toBeNull();
      await act("sam", "quick-replies", { replies: ["Yes", "No"] });
      const cleared = await act<{ quickReplies: unknown }>(
        "sam",
        "quick-replies",
        { replies: null }
      );
      expect(cleared.quickReplies).toBeNull();
    });

    it("refuses one missing, a repeat, or one too long", async () => {
      const missing = await fails("sam", "quick-replies", { replies: ["Yes"] });
      const repeated = await fails("sam", "quick-replies", {
        replies: ["Yes", "YES"],
      });
      const long = await fails("sam", "quick-replies", {
        replies: ["Yes", "I will be there in twenty minutes"],
      });
      expect([missing.message, repeated.message, long.message]).toStrictEqual([
        "Write both reply options",
        "Make the two reply options different",
        "Keep each reply option to 24 characters",
      ]);
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
        "INSERT INTO account_resource(kind,id,user_id,inbox_id,credential_id,name,created_at) VALUES('inbox','legacyinbox','sam','legacyinbox',NULL,'Old Sam',1)"
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
      const ariMac = await act<SyncResult>("ari", "sync", {
        platform: "mac",
        deviceName: "Ari's Mac",
        receive: true,
      });
      expect(refused._tag).toBe("Conflict");
      expect(left.map((c) => c.revoked)).toStrictEqual([true]);
      expect(ariMac.connections).toStrictEqual([]);
    });

    it("lets the inviter tap back as soon as their inbox says someone joined", async () => {
      await act("ari", "profile", { name: "Ari", color: "moss" });
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const code = await inviteFrom("ari");
      let ariMac: SyncResult | null = null;
      onRedeemed = async () => {
        onRedeemed = null;
        ariMac = await act<SyncResult>("ari", "sync", {
          platform: "mac",
          deviceName: "Ari's Mac",
          receive: true,
        });
      };
      await act("sam", "accept", { ...phone, code });
      expect(
        (ariMac as SyncResult | null)?.senders.map((s) => s.grant.recipientName)
      ).toStrictEqual(["Sam"]);
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
  describe("each person you tap sees you your way", () => {
    it("starts with your profile until you choose another", async () => {
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const me = await act("sam", "me");
      expect(me.sendProfile).toStrictEqual({ name: "Sam", color: "tomato" });
    });

    it("lets you choose how just the new person sees you", async () => {
      await act("ari", "profile", { name: "Ari", color: "moss" });
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const accepted = await act<{ sender: { name: string; color: string } }>(
        "sam",
        "accept",
        {
          ...phone,
          code: await inviteFrom("ari"),
          profile: { name: "Dr. Sam", color: "sky" },
        }
      );
      expect(accepted.sender).toMatchObject({ name: "Dr. Sam", color: "sky" });
      await expect(seenBy("ari")).resolves.toStrictEqual([["Dr. Sam", "sky"]]);
      const me = await act<{ profile: object }>("sam", "me");
      expect(me.profile).toStrictEqual({ name: "Sam", color: "tomato" });
    });

    it("starts the next connection with the profile you used last", async () => {
      await act("ari", "profile", { name: "Ari", color: "moss" });
      await act("jo", "profile", { name: "Jo", color: "plum" });
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      await act("sam", "accept", {
        ...phone,
        code: await inviteFrom("ari"),
        profile: { name: "Sammy", color: "sky" },
      });
      const me = await act("sam", "me");
      await act("sam", "accept", { ...phone, code: await inviteFrom("jo") });
      expect(me.sendProfile).toStrictEqual({ name: "Sammy", color: "sky" });
      await expect(seenBy("jo")).resolves.toStrictEqual([["Sammy", "sky"]]);
    });

    it("shows an invite as the inviter's latest profile, and taps back in it", async () => {
      await act("ari", "profile", { name: "Ari", color: "moss" });
      await act("jo", "profile", { name: "Jo", color: "plum" });
      await act("ari", "accept", {
        ...phone,
        code: await inviteFrom("jo"),
        profile: { name: "Coach Ari", color: "ochre" },
      });
      await act("sam", "profile", { name: "Sam", color: "tomato" });
      const code = await inviteFrom("ari");
      const preview = await Effect.runPromise(
        invitePreview(deps(), code) as Effect.Effect<unknown, unknown>
      );
      await act("sam", "accept", { ...phone, code });
      expect(preview).toMatchObject({ name: "Coach Ari", color: "ochre" });
      await expect(seenBy("sam")).resolves.toStrictEqual([
        ["Coach Ari", "ochre"],
      ]);
    });

    it("changes one person's view later, on every device, leaving others alone", async () => {
      const { accepted } = await connect();
      await act("jo", "profile", { name: "Jo", color: "plum" });
      await act("sam", "accept", { ...phone, code: await inviteFrom("jo") });
      const updated = await act("sam", "send-profile", {
        id: accepted.sender.id,
        name: "Sam the Great",
        color: "plum",
      });
      const samMac = await act<SyncResult>("sam", "sync", {
        platform: "mac",
        deviceName: "Sam's Mac",
        receive: true,
      });
      expect(updated).toStrictEqual({
        id: accepted.sender.id,
        name: "Sam the Great",
        color: "plum",
        theme: null,
      });
      await expect(seenBy("ari")).resolves.toStrictEqual([
        ["Sam the Great", "plum"],
      ]);
      await expect(seenBy("jo")).resolves.toStrictEqual([["Sam", "tomato"]]);
      // Sync promises no order between people.
      expect(
        samMac.senders
          .toSorted((a, b) =>
            a.grant.recipientName.localeCompare(b.grant.recipientName)
          )
          .map((s) => [s.grant.recipientName, s.name, s.color])
      ).toStrictEqual([
        ["Ari", "Sam the Great", "plum"],
        ["Jo", "Sam", "tomato"],
      ]);
    });

    it("can't change how someone else's connection looks", async () => {
      const { accepted } = await connect();
      const refused = await fails("ari", "send-profile", {
        id: accepted.sender.id,
        name: "Not Sam",
        color: "moss",
      });
      expect(refused.message).toBe("No such person");
    });

    it("rejects a blank name for one person", async () => {
      const { accepted } = await connect();
      const refused = await fails("sam", "send-profile", {
        id: accepted.sender.id,
        name: " ",
        color: "moss",
      });
      expect(refused.message).toBe("Enter a name up to 40 characters");
    });
  });

  describe("choosing how the people you invited see you", () => {
    it("asks the inviter once, and not the person who accepted", async () => {
      const { accepted } = await connect();
      const ariPhone = await act<SyncResult>("ari", "sync", {
        platform: "iphone",
        deviceName: "Ari's iPhone",
        receive: true,
      });
      const samPhone = await act<SyncResult>("sam", "sync", {
        ...phone,
        receive: true,
        tokens: [accepted.sender.grant.token],
      });
      expect(ariPhone.senders.map((s) => s.chooseSeenAs)).toStrictEqual([true]);
      expect(ariPhone.connections).toStrictEqual([
        {
          id: ariPhone.senders[0]?.id,
          name: "Ari",
          color: "moss",
          theme: null,
          chooseSeenAs: true,
        },
      ]);
      expect(samPhone.connections).toStrictEqual([
        {
          id: accepted.sender.id,
          name: "Sam",
          color: "tomato",
          theme: null,
          chooseSeenAs: false,
        },
      ]);
    });

    it("stops asking once they save, even unchanged", async () => {
      await connect();
      const ariPhone = await act<SyncResult>("ari", "sync", {
        platform: "iphone",
        deviceName: "Ari's iPhone",
        receive: true,
      });
      const [sender] = ariPhone.senders;
      await act("ari", "send-profile", {
        id: sender?.id,
        name: "Ari",
        color: "moss",
      });
      const again = await act<SyncResult>("ari", "sync", {
        platform: "iphone",
        deviceName: "Ari's iPhone",
        receive: true,
        tokens: [sender?.grant.token],
      });
      expect(again.connections.map((c) => c.chooseSeenAs)).toStrictEqual([
        false,
      ]);
    });
  });

  describe("a theme for each person you tap", () => {
    it("reaches every device, including ones that already tap them", async () => {
      const { accepted } = await connect();
      const saved = await act("sam", "send-profile", {
        id: accepted.sender.id,
        name: "Sam",
        color: "tomato",
        theme: "terminal",
      });
      const samPhone = await act<SyncResult>("sam", "sync", {
        ...phone,
        receive: true,
        tokens: [accepted.sender.grant.token],
      });
      const samMac = await act<SyncResult>("sam", "sync", {
        platform: "mac",
        deviceName: "Sam's Mac",
        receive: true,
      });
      expect(saved).toStrictEqual({
        id: accepted.sender.id,
        name: "Sam",
        color: "tomato",
        theme: "terminal",
      });
      expect(samPhone.senders).toStrictEqual([]);
      expect(samPhone.connections).toStrictEqual([
        {
          id: accepted.sender.id,
          name: "Sam",
          color: "tomato",
          theme: "terminal",
          chooseSeenAs: false,
        },
      ]);
      expect(samMac.senders.map((s) => [s.id, s.theme])).toStrictEqual([
        [accepted.sender.id, "terminal"],
      ]);
    });

    it("keeps the theme when only the name changes, and null follows the device", async () => {
      const { accepted } = await connect();
      await act("sam", "send-profile", {
        id: accepted.sender.id,
        name: "Sam",
        color: "tomato",
        theme: "note",
      });
      const renamed = await act<{ theme: string | null }>(
        "sam",
        "send-profile",
        { id: accepted.sender.id, name: "Sammy", color: "sky" }
      );
      const cleared = await act<{ theme: string | null }>(
        "sam",
        "send-profile",
        { id: accepted.sender.id, name: "Sammy", color: "sky", theme: null }
      );
      expect([renamed.theme, cleared.theme]).toStrictEqual(["note", null]);
    });

    it("refuses a theme that doesn't exist", async () => {
      const { accepted } = await connect();
      const refused = await fails("sam", "send-profile", {
        id: accepted.sender.id,
        name: "Sam",
        color: "tomato",
        theme: "neon",
      });
      expect(refused.message).toBe("Choose a theme");
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

    it("leaves your taps in their inbox unless you ask", async () => {
      const { accepted } = await connect();
      const tapsAtAri = await tapAtAri(accepted.sender.id.split(":")[1] ?? "");
      await act("sam", "remove", { id: accepted.sender.id });
      expect(tapsAtAri()).toStrictEqual(["Lunch?"]);
    });

    it("can delete your taps with them, from every device", async () => {
      const { accepted } = await connect();
      const samMac = await act<SyncResult>("sam", "sync", {
        platform: "mac",
        deviceName: "Sam's Mac",
        receive: true,
      });
      const macKey = samMac.senders[0]?.grant.token ?? "";
      const tapsAtAri = await tapAtAri(accepted.sender.id.split(":")[1] ?? "");
      const removed = await act("sam", "remove", {
        id: accepted.sender.id,
        deleteData: true,
      });
      const macAfter = await act<SyncResult>("sam", "sync", {
        platform: "mac",
        deviceName: "Sam's Mac",
        receive: true,
        tokens: [macKey],
      });
      expect(removed).toStrictEqual({ removed: true });
      expect(tapsAtAri()).toStrictEqual([]);
      await expect(seenBy("ari")).resolves.toStrictEqual([]);
      expect([macAfter.removed, macAfter.connections]).toStrictEqual([
        [macKey],
        [],
      ]);
    });

    it("lets you connect again after deleting your taps", async () => {
      const { accepted } = await connect();
      await act("sam", "remove", { id: accepted.sender.id, deleteData: true });
      const again = await act<{ sender: { name: string } | null }>(
        "sam",
        "accept",
        { ...phone, code: await inviteFrom("ari") }
      );
      expect(again.sender?.name).toBe("Sam");
      await expect(seenBy("ari")).resolves.toStrictEqual([["Sam", "tomato"]]);
    });

    it("comes off the account when a device already deleted it, so you can connect again", async () => {
      const { accepted } = await connect();
      const ari = await act<{ inboxId: string }>("ari", "me");
      // `DELETE /v1/sender` from one of Sam's devices: gone from Ari's inbox,
      // still on Sam's account.
      world
        .get(ari.inboxId)
        ?.credentials.delete(accepted.sender.id.split(":")[1] ?? "");
      const stuck = await act<{ sender: object | null }>("sam", "accept", {
        ...phone,
        code: await inviteFrom("ari"),
      });
      const removed = await act("sam", "remove", {
        id: accepted.sender.id,
        deleteData: true,
      });
      const again = await act<{ sender: { name: string } | null }>(
        "sam",
        "accept",
        { ...phone, code: await inviteFrom("ari") }
      );
      expect(stuck.sender).toBeNull();
      expect(removed).toStrictEqual({ removed: true });
      expect(again.sender?.name).toBe("Sam");
    });
  });
});
