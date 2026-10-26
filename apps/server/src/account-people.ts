import {
  Conflict,
  InvalidRequest,
  MAX_NAME_LENGTH,
  NotFound,
  parseToken,
  personColors,
} from "@shouldertap/domain";
import type { CredentialGrant, PersonColor } from "@shouldertap/domain";
import * as Effect from "effect/Effect";

import { accountResources, claimAccountResource } from "./account-identity";
import type { Track } from "./analytics";
import type { PushContext } from "./apns";
import type { InboxRpc } from "./Inbox";

/** Account-first onboarding (docs/onboarding.md): the account is the person,
 * signing in links a device, and accepting an invite connects both people. */

interface Dependencies {
  db: D1Database;
  inboxes: { getByName: (id: string) => InboxRpc };
}

/** Actions that create people or connections report them. */
interface TrackedDependencies extends Dependencies {
  track: Track;
  /** A signed APNs token, so the inviter's iPhones hear who joined. */
  pushContext?: Effect.Effect<PushContext | undefined>;
}

export interface Profile {
  name: string;
  color: PersonColor;
}

export interface Me {
  email: string;
  profile: Profile | null;
  suggestedName: string | null;
  inboxId: string | null;
}

export interface AccountSender {
  id: string;
  grant: CredentialGrant;
  name: string;
  color: PersonColor;
}

const platforms = ["iphone", "mac", "windows", "web"] as const;
type Platform = (typeof platforms)[number];

const first = <A>(db: D1Database, sql: string, ...values: unknown[]) =>
  Effect.promise(() =>
    db
      .prepare(sql)
      .bind(...values)
      .first<A>()
  );
const run = (db: D1Database, sql: string, ...values: unknown[]) =>
  Effect.promise(() =>
    db
      .prepare(sql)
      .bind(...values)
      .run()
  );

const isColor = (value: unknown): value is PersonColor =>
  (personColors as readonly unknown[]).includes(value);

export const readProfile = Effect.fn(function* readProfile(
  db: D1Database,
  userId: string
) {
  const row = yield* first<{ name: string; color: string }>(
    db,
    "SELECT name,color FROM account_profile WHERE user_id=?",
    userId
  );
  return row && isColor(row.color)
    ? ({ name: row.name, color: row.color } satisfies Profile)
    : null;
});

/** The person's inbox: the chosen default, else the first one they owned. */
const primaryInbox = Effect.fn(function* primaryInbox(
  db: D1Database,
  userId: string
) {
  const preference = yield* first<{ default_inbox_id: string | null }>(
    db,
    "SELECT default_inbox_id FROM account_preference WHERE user_id=?",
    userId
  );
  const inboxes = (yield* accountResources(db, userId)).filter(
    (r) => r.kind === "inbox"
  );
  return (
    inboxes.find((r) => r.id === preference?.default_inbox_id) ??
    inboxes[0] ??
    null
  );
});

export const accountMe = Effect.fn(function* accountMe(
  db: D1Database,
  userId: string
) {
  const user = yield* first<{ email: string }>(
    db,
    "SELECT email FROM user WHERE id=?",
    userId
  );
  const profile = yield* readProfile(db, userId);
  const inbox = yield* primaryInbox(db, userId);
  return {
    email: user?.email ?? "",
    profile,
    suggestedName: profile ? null : (inbox?.name ?? null),
    inboxId: profile ? (inbox?.id ?? null) : null,
  } satisfies Me;
});

/** Deterministic, so two first profile saves converge on one inbox. */
const accountInboxId = (userId: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`shouldertap-account-inbox-v1:${userId}`)
    );
    return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  });

const parseProfile = (input: Record<string, unknown>) => {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    return Effect.fail(
      new InvalidRequest({
        message: `Enter a name up to ${MAX_NAME_LENGTH} characters`,
      })
    );
  }
  if (!isColor(input.color)) {
    return Effect.fail(new InvalidRequest({ message: "Choose a color" }));
  }
  return Effect.succeed({ name, color: input.color } satisfies Profile);
};

export const saveProfile = Effect.fn(function* saveProfile(
  { db, inboxes, track }: TrackedDependencies,
  userId: string,
  input: Record<string, unknown>
) {
  const profile = yield* parseProfile(input);
  yield* run(
    db,
    "INSERT INTO account_profile(user_id,name,color,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,color=excluded.color,updated_at=excluded.updated_at",
    userId,
    profile.name,
    profile.color,
    Date.now()
  );
  const existing = yield* primaryInbox(db, userId);
  if (existing) {
    yield* inboxes
      .getByName(existing.id)
      .rename(existing.id, profile.name)
      .pipe(Effect.catchTag("Unauthorized", () => Effect.void));
    yield* run(
      db,
      "UPDATE account_resource SET name=? WHERE kind='inbox' AND id=? AND user_id=?",
      profile.name,
      existing.id,
      userId
    );
  } else {
    const inboxId = yield* accountInboxId(userId);
    const { created } = yield* inboxes
      .getByName(inboxId)
      .initializeForAccount(inboxId, profile.name);
    if (created) {
      yield* track(
        { name: "inbox_created", inboxId, userId, platform: null },
        Date.now()
      );
    }
    yield* claimAccountResource(db, userId, {
      kind: "inbox",
      id: inboxId,
      inbox_id: inboxId,
      credential_id: null,
      name: profile.name,
    });
  }
  return yield* accountMe(db, userId);
});

const requireProfile = Effect.fn(function* requireProfile(
  db: D1Database,
  userId: string
) {
  const profile = yield* readProfile(db, userId);
  if (!profile) {
    return yield* new Conflict({ message: "Choose your name first" });
  }
  const inbox = yield* primaryInbox(db, userId);
  if (!inbox) {
    return yield* new Conflict({ message: "Choose your name first" });
  }
  return { profile, inbox };
});

const parseDevice = (input: Record<string, unknown>) => {
  const platform = input.platform as Platform;
  if (!platforms.includes(platform)) {
    return Effect.fail(new InvalidRequest({ message: "Invalid platform" }));
  }
  const deviceName =
    typeof input.deviceName === "string" ? input.deviceName.trim() : "";
  if (!deviceName || deviceName.length > 80) {
    return Effect.fail(new InvalidRequest({ message: "Invalid device name" }));
  }
  return Effect.succeed({ platform, deviceName });
};

/** Issues this device its own key for a connection the account owns. */
const senderKey = (
  inboxes: Dependencies["inboxes"],
  resource: { inbox_id: string | null; credential_id: string | null },
  deviceName: string,
  profile: Profile
) =>
  inboxes
    .getByName(resource.inbox_id ?? "")
    // A sender key has no platform; the parameter only types devices.
    .accountRestore(
      resource.inbox_id ?? "",
      resource.credential_id,
      deviceName,
      "iphone"
    )
    .pipe(
      Effect.map((grant): AccountSender => ({
        id: `${resource.inbox_id}:${resource.credential_id}`,
        grant,
        name: profile.name,
        color: profile.color,
      }))
    );

/** Saves what a device already holds to the account and reports what it
 * holds, skipping anything another account owns. Dead tokens come back to
 * be dropped. */
const saveHeld = Effect.fn(function* saveHeld(
  { db, inboxes }: Dependencies,
  userId: string,
  tokens: readonly string[]
) {
  const heldInboxes = new Set<string>();
  const heldSenders = new Set<string>();
  const removed: string[] = [];
  for (const value of tokens) {
    const token = parseToken(value);
    if (!token) {
      removed.push(value);
      continue;
    }
    const identity = yield* inboxes
      .getByName(token.inboxId)
      .identify(token)
      .pipe(Effect.catchTag("Unauthorized", () => Effect.succeed(null)));
    if (!identity) {
      removed.push(value);
      continue;
    }
    const owner = identity.kind === "device";
    const id = owner
      ? token.inboxId
      : `${token.inboxId}:${identity.credentialId}`;
    const claimed = yield* claimAccountResource(db, userId, {
      kind: owner ? "inbox" : "sender",
      id,
      inbox_id: token.inboxId,
      credential_id: owner ? null : identity.credentialId,
      name: identity.recipientName,
    }).pipe(
      Effect.as(true),
      Effect.catchTag("Conflict", () => Effect.succeed(false))
    );
    if (claimed) {
      (owner ? heldInboxes : heldSenders).add(id);
    }
  }

  return { heldInboxes, heldSenders, removed };
});

export const syncDevice = Effect.fn(function* syncDevice(
  { db, inboxes }: Dependencies,
  userId: string,
  input: Record<string, unknown>
) {
  const { platform, deviceName } = yield* parseDevice(input);
  if (typeof input.receive !== "boolean") {
    return yield* new InvalidRequest({ message: "Invalid receive" });
  }
  const receive = input.receive && platform !== "web";
  const tokens = input.tokens ?? [];
  if (
    !Array.isArray(tokens) ||
    tokens.length > 50 ||
    tokens.some((t) => typeof t !== "string")
  ) {
    return yield* new InvalidRequest({ message: "Invalid credentials" });
  }
  const { profile, inbox } = yield* requireProfile(db, userId);

  const { heldInboxes, heldSenders, removed } = yield* saveHeld(
    { db, inboxes },
    userId,
    tokens as string[]
  );

  const grant =
    receive && !heldInboxes.has(inbox.id)
      ? yield* inboxes
          .getByName(inbox.id)
          .accountRestore(inbox.id, null, deviceName, platform as never)
      : null;

  const senders: AccountSender[] = [];
  for (const resource of yield* accountResources(db, userId)) {
    if (resource.kind !== "sender" || heldSenders.has(resource.id)) {
      continue;
    }
    // A connection its recipient removed, or one with no room for another
    // key, is skipped; the rest of the device still syncs.
    const key = yield* senderKey(inboxes, resource, deviceName, profile).pipe(
      Effect.catchTags({
        Unauthorized: () => Effect.succeed(null),
        Conflict: () => Effect.succeed(null),
      })
    );
    if (key) {
      senders.push(key);
    }
  }
  return {
    me: yield* accountMe(db, userId),
    inbox: grant,
    senders,
    removed,
  };
});

export const accountInvite = Effect.fn(function* accountInvite(
  { db, inboxes }: Dependencies,
  userId: string
) {
  const { inbox } = yield* requireProfile(db, userId);
  return yield* inboxes.getByName(inbox.id).accountInvite(inbox.id);
});

const inviterOf = Effect.fn(function* inviterOf(
  db: D1Database,
  inboxId: string
) {
  const owner = yield* first<{ user_id: string }>(
    db,
    "SELECT user_id FROM account_resource WHERE kind='inbox' AND id=?",
    inboxId
  );
  if (!owner) {
    return null;
  }
  const profile = yield* readProfile(db, owner.user_id);
  return profile ? { userId: owner.user_id, profile } : null;
});

/** Who an invite is from: the inviter's own profile when they have one. */
export const invitePreview = Effect.fn(function* invitePreview(
  { db, inboxes }: Dependencies,
  code: string
) {
  const parsed = parseToken(code);
  if (!parsed) {
    return yield* new NotFound({ message: "This invite link isn't valid" });
  }
  const invite = yield* inboxes.getByName(parsed.inboxId).previewInvite(parsed);
  const inviter = yield* inviterOf(db, parsed.inboxId);
  return {
    name: inviter?.profile.name ?? invite.recipientName,
    color: inviter?.profile.color ?? null,
    expiresAt: invite.expiresAt,
  };
});

/**
 * Accepting connects both people: you can tap them (a sender in their inbox)
 * and they can tap you (a sender in yours). The halves live in two Inbox
 * objects with no shared transaction, so the reverse half is made first and
 * removed again if redeeming the invite fails.
 */
export const acceptInvite = Effect.fn(function* acceptInvite(
  { db, inboxes, track, pushContext }: TrackedDependencies,
  userId: string,
  input: Record<string, unknown>
) {
  yield* parseDevice(input);
  const code = typeof input.code === "string" ? parseToken(input.code) : null;
  if (!code) {
    return yield* new NotFound({ message: "This invite link isn't valid" });
  }
  const { profile, inbox } = yield* requireProfile(db, userId);
  const mine = yield* accountResources(db, userId);
  if (mine.some((r) => r.kind === "inbox" && r.id === code.inboxId)) {
    return yield* new InvalidRequest({ message: "That's your own invite" });
  }
  const preview = yield* inboxes.getByName(code.inboxId).previewInvite(code);
  const inviter = yield* inviterOf(db, code.inboxId);
  const person = {
    name: inviter?.profile.name ?? preview.recipientName,
    color: inviter?.profile.color ?? null,
  };

  const theirs = inviter ? yield* accountResources(db, inviter.userId) : [];
  const reverse =
    inviter &&
    !theirs.some((r) => r.kind === "sender" && r.inbox_id === inbox.id)
      ? yield* inboxes
          .getByName(inbox.id)
          .addAccountSender(
            inbox.id,
            inviter.profile.name,
            inviter.profile.color
          )
      : null;
  // Built only if redeeming fails, so nothing is undone on success.
  const undoReverse = Effect.suspend(() =>
    reverse
      ? inboxes.getByName(inbox.id).removeAccountSender(reverse.credentialId)
      : Effect.void
  );

  const already = mine.find(
    (r) => r.kind === "sender" && r.inbox_id === code.inboxId
  );
  let sender: AccountSender | null = null;
  if (!already) {
    const push = pushContext ? yield* pushContext : undefined;
    const grant = yield* inboxes
      .getByName(code.inboxId)
      .redeemInvite(
        code,
        {
          code: input.code as string,
          name: profile.name,
          color: profile.color,
        },
        push
      )
      .pipe(Effect.tapError(() => undoReverse));
    const id = `${code.inboxId}:${grant.credentialId}`;
    yield* claimAccountResource(db, userId, {
      kind: "sender",
      id,
      inbox_id: code.inboxId,
      credential_id: grant.credentialId,
      name: grant.recipientName,
    });
    sender = { id, grant, name: profile.name, color: profile.color };
    yield* track(
      {
        name: "invite_redeemed",
        inboxId: code.inboxId,
        credentialId: grant.credentialId,
        kind: grant.kind,
        userId,
        platform: null,
      },
      Date.now()
    );
  }
  if (reverse && inviter) {
    yield* claimAccountResource(db, inviter.userId, {
      kind: "sender",
      id: `${inbox.id}:${reverse.credentialId}`,
      inbox_id: inbox.id,
      credential_id: reverse.credentialId,
      name: profile.name,
    });
  }
  return { person, sender, mutual: inviter !== null };
});

/** Stops tapping someone from every device: the connection ends, so sync
 * won't issue a key for it again. They can still tap you. */
export const removePerson = Effect.fn(function* removePerson(
  { db, inboxes }: Dependencies,
  userId: string,
  input: Record<string, unknown>
) {
  const resource = (yield* accountResources(db, userId)).find(
    (r) => r.kind === "sender" && r.id === input.id
  );
  if (!resource?.inbox_id || !resource.credential_id) {
    return yield* new NotFound({ message: "No such person" });
  }
  yield* inboxes
    .getByName(resource.inbox_id)
    .removeAccountSender(resource.credential_id);
  yield* run(
    db,
    "DELETE FROM account_resource WHERE kind='sender' AND id=? AND user_id=?",
    resource.id,
    userId
  );
  return { removed: true as const };
});

/** Route actions for docs/onboarding.md; null when the path isn't one. */
export const peopleAction = (
  deps: TrackedDependencies,
  userId: string,
  action: string,
  body: unknown
) => {
  const input =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  switch (action) {
    case "me": {
      return accountMe(deps.db, userId);
    }
    case "profile": {
      return saveProfile(deps, userId, input);
    }
    case "sync": {
      return syncDevice(deps, userId, input);
    }
    case "invite": {
      return accountInvite(deps, userId);
    }
    case "accept": {
      return acceptInvite(deps, userId, input);
    }
    case "remove": {
      return removePerson(deps, userId, input);
    }
    default: {
      return null;
    }
  }
};
