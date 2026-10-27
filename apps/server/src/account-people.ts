import {
  Conflict,
  InvalidRequest,
  MAX_NAME_LENGTH,
  NotFound,
  normalizeQuickReplies,
  parseToken,
  personColors,
  TAP_THEMES,
} from "@shouldertap/domain";
import type {
  CredentialGrant,
  PersonColor,
  QuickReplies,
  TapTheme,
} from "@shouldertap/domain";
import * as Effect from "effect/Effect";

import { accountResources, claimAccountResource } from "./account-identity";
import type { Track } from "./analytics";
import type { PushContext } from "./apns";
import { isObjectionable } from "./content";
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
  /** How a new connection sees you unless you choose otherwise: the profile
   * you set most recently, for anyone. Null until `profile` exists. */
  sendProfile: Profile | null;
  suggestedName: string | null;
  inboxId: string | null;
  /** The answers their taps offer unless changed on one; null offers On it
   * and In 10 min. */
  quickReplies: QuickReplies | null;
}

/** How one person you tap sees you. */
export interface SeenAs extends Profile {
  /** The theme taps to them go in; null follows the sending device's style.
   * Entitlement is checked on each send, not here. */
  theme: TapTheme | null;
  /** Ask once how they should see you: the inviter's half of a connection
   * their accepted invite made, until send-profile is saved for it. */
  chooseSeenAs: boolean;
}

/** One person you tap, as sync reports it for every connection (held keys
 * included), so each device keeps its pairings' appearance current. */
export interface AccountConnection extends SeenAs {
  /** `${inboxId}:${credentialId}`, like `AccountSender.id`. */
  id: string;
}

export interface AccountSender extends AccountConnection {
  grant: CredentialGrant;
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

const parseColor = (value: unknown) =>
  typeof value === "string" && isColor(value) ? value : null;

const parseTheme = (value: unknown): TapTheme | null =>
  typeof value === "string" && (TAP_THEMES as readonly string[]).includes(value)
    ? (value as TapTheme)
    : null;

/**
 * The profile a new connection starts with: the one picked for the latest
 * connection, else the account profile.
 */
export const sendProfile = Effect.fn(function* sendProfile(
  db: D1Database,
  userId: string
) {
  const latest = yield* first<{
    send_name: string | null;
    send_color: string | null;
  }>(
    db,
    "SELECT send_name,send_color FROM account_preference WHERE user_id=?",
    userId
  );
  const color = parseColor(latest?.send_color);
  if (latest?.send_name && color) {
    return { name: latest.send_name, color } satisfies Profile;
  }
  return yield* readProfile(db, userId);
});

const rememberLatest = (
  db: D1Database,
  userId: string,
  profile: Profile | null
) =>
  run(
    db,
    "INSERT INTO account_preference(user_id,send_name,send_color) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET send_name=excluded.send_name,send_color=excluded.send_color",
    userId,
    profile?.name ?? null,
    profile?.color ?? null
  );

interface SeenAsRow {
  send_name: string | null;
  send_color: string | null;
  send_theme: string | null;
  choose_seen_as: number | null;
}

/** How one connection sees you; the account profile for older ones. */
const connectionSeenAs = (
  resource: SeenAsRow | undefined,
  fallback: Profile
): SeenAs => {
  const color = parseColor(resource?.send_color);
  return {
    ...(resource?.send_name && color
      ? { name: resource.send_name, color }
      : fallback),
    theme: parseTheme(resource?.send_theme),
    chooseSeenAs: resource?.choose_seen_as === 1,
  };
};

/**
 * Saves how one connection sees you, which also answers the one-time ask.
 * `theme` undefined keeps the saved one; null goes back to following the
 * sending device's style.
 */
const rememberConnectionProfile = (
  db: D1Database,
  userId: string,
  id: string,
  profile: Profile,
  theme?: TapTheme | null
) =>
  theme === undefined
    ? run(
        db,
        "UPDATE account_resource SET send_name=?,send_color=?,choose_seen_as=NULL WHERE kind='sender' AND id=? AND user_id=?",
        profile.name,
        profile.color,
        id,
        userId
      )
    : run(
        db,
        "UPDATE account_resource SET send_name=?,send_color=?,send_theme=?,choose_seen_as=NULL WHERE kind='sender' AND id=? AND user_id=?",
        profile.name,
        profile.color,
        theme,
        id,
        userId
      );

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
  const replies = yield* first<{ first: string; second: string }>(
    db,
    "SELECT first,second FROM account_quick_replies WHERE user_id=?",
    userId
  );
  return {
    email: user?.email ?? "",
    profile,
    sendProfile: profile ? yield* sendProfile(db, userId) : null,
    suggestedName: profile ? null : (inbox?.name ?? null),
    inboxId: profile ? (inbox?.id ?? null) : null,
    quickReplies: replies ? [replies.first, replies.second] : null,
  } satisfies Me;
});

/** `POST /account/quick-replies` with `{ replies: [first, second] }`, or
 * `{ replies: null }` to go back to On it and In 10 min. */
export const saveQuickReplies = Effect.fn(function* saveQuickReplies(
  db: D1Database,
  userId: string,
  input: Record<string, unknown>
) {
  const requested = input.replies;
  const typed =
    Array.isArray(requested) &&
    requested.every((reply) => typeof reply === "string");
  if (requested !== null && !typed) {
    return yield* new InvalidRequest({ message: "Write both reply options" });
  }
  const tidied = typed ? normalizeQuickReplies(requested) : { replies: null };
  if ("error" in tidied) {
    return yield* new InvalidRequest({ message: tidied.error });
  }
  if (tidied.replies?.some((reply) => isObjectionable(reply))) {
    return yield* new InvalidRequest({
      message:
        "These replies contain threatening or abusive language. Please rewrite them.",
    });
  }
  yield* tidied.replies
    ? run(
        db,
        "INSERT INTO account_quick_replies(user_id,first,second,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET first=excluded.first,second=excluded.second,updated_at=excluded.updated_at",
        userId,
        tidied.replies[0],
        tidied.replies[1],
        Date.now()
      )
    : run(db, "DELETE FROM account_quick_replies WHERE user_id=?", userId);
  return yield* accountMe(db, userId);
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
  yield* rememberLatest(db, userId, null);
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
  return {
    profile,
    inbox,
    sendDefault: (yield* sendProfile(db, userId)) ?? profile,
  };
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
  seenAs: SeenAs
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
        ...seenAs,
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

const sendProfiles = Effect.fn(function* sendProfiles(
  db: D1Database,
  userId: string
) {
  const rows = yield* Effect.promise(() =>
    db
      .prepare(
        "SELECT id,send_name,send_color,send_theme,choose_seen_as FROM account_resource WHERE user_id=? AND kind='sender'"
      )
      .bind(userId)
      .all<SeenAsRow & { id: string }>()
  );
  return new Map(rows.results.map((row) => [row.id, row]));
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
  const connections: AccountConnection[] = [];
  const sent = yield* sendProfiles(db, userId);
  for (const resource of yield* accountResources(db, userId)) {
    if (resource.kind !== "sender") {
      continue;
    }
    const seenAs = connectionSeenAs(sent.get(resource.id), profile);
    connections.push({ id: resource.id, ...seenAs });
    if (heldSenders.has(resource.id)) {
      continue;
    }
    // A connection its recipient removed, or one with no room for another
    // key, is skipped; the rest of the device still syncs.
    const key = yield* senderKey(inboxes, resource, deviceName, seenAs).pipe(
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
    connections,
  };
});

export const accountInvite = Effect.fn(function* accountInvite(
  { db, inboxes }: Dependencies,
  userId: string
) {
  const { inbox, sendDefault } = yield* requireProfile(db, userId);
  const invite = yield* inboxes.getByName(inbox.id).accountInvite(inbox.id);
  return { ...invite, inviter: sendDefault };
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
  // How they'll appear to whoever accepts: the profile they used last.
  const profile = yield* sendProfile(db, owner.user_id);
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
 * objects with no shared transaction, so the reverse half is made (and put
 * on the inviter's account) first and removed again if redeeming the invite
 * fails.
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
  const { inbox, sendDefault } = yield* requireProfile(db, userId);
  // Chosen for just this person, or the one used last.
  const profile =
    input.profile && typeof input.profile === "object"
      ? yield* parseProfile(input.profile as Record<string, unknown>)
      : sendDefault;
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
  // Claimed on the inviter's account before redeeming: redeeming tells
  // their devices the inbox changed, and the sync that prompts must already
  // find this half. They didn't choose how this person sees them, so their
  // app asks once.
  const reverseId = reverse ? `${inbox.id}:${reverse.credentialId}` : null;
  if (reverse && reverseId && inviter) {
    yield* claimAccountResource(db, inviter.userId, {
      kind: "sender",
      id: reverseId,
      inbox_id: inbox.id,
      credential_id: reverse.credentialId,
      name: inbox.name,
    });
    yield* rememberConnectionProfile(
      db,
      inviter.userId,
      reverseId,
      inviter.profile
    );
    yield* run(
      db,
      "UPDATE account_resource SET choose_seen_as=1 WHERE kind='sender' AND id=? AND user_id=?",
      reverseId,
      inviter.userId
    );
  }
  // Built only if redeeming fails, so nothing is undone on success.
  const undoReverse = Effect.suspend(() =>
    reverse && inviter
      ? inboxes
          .getByName(inbox.id)
          .removeAccountSender(reverse.credentialId)
          .pipe(
            Effect.andThen(
              run(
                db,
                "DELETE FROM account_resource WHERE kind='sender' AND id=? AND user_id=?",
                reverseId,
                inviter.userId
              )
            )
          )
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
    yield* rememberConnectionProfile(db, userId, id, profile);
    yield* rememberLatest(db, userId, profile);
    // The accepter chose how the inviter sees them just now: nothing to ask.
    sender = {
      id,
      grant,
      ...connectionSeenAs(undefined, profile),
    };
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
  return { person, sender, mutual: inviter !== null };
});

/**
 * Stops tapping someone from every device: the connection ends, so sync
 * won't issue a key for it again. They can still tap you. With
 * `deleteData: true` your taps to them go too, as `DELETE /v1/sender` would,
 * for every device's key. A connection their inbox already removed or
 * deleted still comes off the account.
 */
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
  const theirs = inboxes.getByName(resource.inbox_id);
  yield* input.deleteData === true
    ? theirs.deleteAccountSender(resource.credential_id)
    : theirs.removeAccountSender(resource.credential_id);
  yield* run(
    db,
    "DELETE FROM account_resource WHERE kind='sender' AND id=? AND user_id=?",
    resource.id,
    userId
  );
  return { removed: true as const };
});

/** `theme` in a send-profile request: missing (undefined) keeps the saved
 * one, null follows the device's style. */
const parseSendTheme = (
  input: Record<string, unknown>
): Effect.Effect<TapTheme | null | undefined, InvalidRequest> => {
  const requested = input.theme;
  if (requested === undefined || requested === null) {
    return Effect.succeed(requested);
  }
  const theme = parseTheme(requested);
  return theme
    ? Effect.succeed(theme)
    : Effect.fail(new InvalidRequest({ message: "Choose a theme" }));
};

/**
 * Changes how one person you tap sees you, on every device: their screens
 * show the new name and color on your taps, past ones included. `theme`
 * (optional; null follows the device's style) is what your devices send new
 * taps to them in, verified at each send; past taps keep theirs. Saving,
 * even unchanged, answers the one-time ask (`chooseSeenAs`).
 */
export const updateSendProfile = Effect.fn(function* updateSendProfile(
  { db, inboxes }: Dependencies,
  userId: string,
  input: Record<string, unknown>
) {
  const profile = yield* parseProfile(input);
  const theme = yield* parseSendTheme(input);
  const resource = (yield* accountResources(db, userId)).find(
    (r) => r.kind === "sender" && r.id === input.id
  );
  if (!resource?.inbox_id || !resource.credential_id) {
    return yield* new NotFound({ message: "No such person" });
  }
  yield* inboxes
    .getByName(resource.inbox_id)
    .updateAccountSender(resource.credential_id, profile.name, profile.color)
    .pipe(
      Effect.catchTag("Unauthorized", () =>
        Effect.fail(new NotFound({ message: "No such person" }))
      )
    );
  yield* rememberConnectionProfile(db, userId, resource.id, profile, theme);
  const saved = yield* first<{ send_theme: string | null }>(
    db,
    "SELECT send_theme FROM account_resource WHERE kind='sender' AND id=? AND user_id=?",
    resource.id,
    userId
  );
  return {
    id: resource.id,
    ...profile,
    theme: parseTheme(saved?.send_theme),
  };
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
    case "quick-replies": {
      return saveQuickReplies(deps.db, userId, input);
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
    case "send-profile": {
      return updateSendProfile(deps, userId, input);
    }
    default: {
      return null;
    }
  }
};
