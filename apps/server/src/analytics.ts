import type {
  CredentialKind,
  DevicePlatform,
  ResponseKind,
} from "@shouldertap/domain";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";

import { hashSecret } from "./secrets";

/** PostHog US cloud ingestion. */
export const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";

/**
 * Every product event the server reports. Properties are ids and enums only:
 * no names, emails, tap text or replies ever leave for PostHog (see the
 * privacy policy, apps/web/src/routes/privacy.tsx). Add an event here, not as
 * a free-form object, so that stays true.
 */
export type AnalyticsEvent =
  | { name: "account_created"; userId: string }
  | {
      name: "inbox_created";
      inboxId: string;
      /** Set when the inbox came from account onboarding. */
      userId: string | null;
      /** Which device set it up; null for account onboarding. */
      platform: DevicePlatform | null;
    }
  | {
      name: "invite_redeemed";
      inboxId: string;
      credentialId: string;
      kind: CredentialKind;
      /** Set when accepted while signed in to an account. */
      userId: string | null;
      platform: DevicePlatform | null;
    }
  | {
      name: "tap_sent";
      inboxId: string;
      tapId: string;
      senderId: string;
      themed: boolean;
    }
  | {
      name: "tap_answered";
      inboxId: string;
      tapId: string;
      deviceId: string;
      response: ResponseKind;
    }
  | {
      name: PatronEventName;
      /** Creem's event id. */
      creemEventId: string;
      /** The patron identity, or the inbox for historical receiver subscriptions. */
      ownerId: string;
      ownerKind: "patron" | "inbox";
    };

const patronEventNames = {
  "subscription.active": "patron_subscribed",
  "subscription.paid": "patron_paid",
  "subscription.scheduled_cancel": "patron_cancel_scheduled",
  "subscription.canceled": "patron_canceled",
  "refund.created": "patron_refunded",
} as const;

type PatronEventName = (typeof patronEventNames)[keyof typeof patronEventNames];

/** The analytics name for a Creem subscription fact, if it's one we report. */
export const patronEventName = (creemType: string): PatronEventName | null =>
  Object.hasOwn(patronEventNames, creemType)
    ? patronEventNames[creemType as keyof typeof patronEventNames]
    : null;

/**
 * Who did it, in PostHog's terms, and the fact's own id. Retried requests
 * report the same fact again; the same uuid, person and timestamp make
 * PostHog keep one copy.
 */
const identity = (event: AnalyticsEvent) => {
  switch (event.name) {
    case "account_created": {
      return { person: event.userId, fact: event.userId };
    }
    case "inbox_created": {
      return { person: event.userId ?? event.inboxId, fact: event.inboxId };
    }
    case "invite_redeemed": {
      return {
        person: event.userId ?? event.credentialId,
        fact: event.credentialId,
      };
    }
    case "tap_sent": {
      return { person: event.senderId, fact: event.tapId };
    }
    case "tap_answered": {
      // The recipient answers, from whichever device: racing devices and
      // retries all collapse into the first answer.
      return { person: event.inboxId, fact: event.tapId };
    }
    default: {
      return { person: event.ownerId, fact: event.creemEventId };
    }
  }
};

/** Resolve verified resource ownership without sending credentials or profile data. */
export const analyticsPerson = async (
  db: D1Database,
  event: AnalyticsEvent
): Promise<string> => {
  const fallback = identity(event).person;
  if (
    event.name === "account_created" ||
    ((event.name === "inbox_created" || event.name === "invite_redeemed") &&
      event.userId)
  ) {
    return fallback;
  }
  let resource: { kind: string; id: string };
  switch (event.name) {
    case "tap_sent": {
      resource = { kind: "sender", id: `${event.inboxId}:${event.senderId}` };
      break;
    }
    case "invite_redeemed": {
      resource =
        event.kind === "device"
          ? { kind: "inbox", id: event.inboxId }
          : { kind: "sender", id: `${event.inboxId}:${event.credentialId}` };
      break;
    }
    case "inbox_created":
    case "tap_answered": {
      resource = { kind: "inbox", id: event.inboxId };
      break;
    }
    default: {
      resource = { kind: event.ownerKind, id: event.ownerId };
    }
  }
  const owner = await db
    .prepare("SELECT user_id FROM account_resource WHERE kind=? AND id=?")
    .bind(resource.kind, resource.id)
    .first<{ user_id: string }>();
  return owner?.user_id ?? fallback;
};

/** A stable UUID (version 8 layout) from SHA-256 of `key`. */
const stableUuid = (key: string) =>
  hashSecret(key).pipe(
    Effect.map((hex) => {
      // Version nibble 8; variant bits 10xx.
      const variant = ((Number.parseInt(hex.charAt(16), 16) % 4) + 8).toString(
        16
      );
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    })
  );

/** Explicit fields keep profile data out even when callers pass a wider object. */
const eventProperties = (event: AnalyticsEvent) => {
  switch (event.name) {
    case "account_created": {
      return { userId: event.userId };
    }
    case "inbox_created": {
      return {
        inboxId: event.inboxId,
        userId: event.userId,
        platform: event.platform,
      };
    }
    case "invite_redeemed": {
      return {
        inboxId: event.inboxId,
        credentialId: event.credentialId,
        kind: event.kind,
        userId: event.userId,
        platform: event.platform,
      };
    }
    case "tap_sent": {
      return {
        inboxId: event.inboxId,
        tapId: event.tapId,
        senderId: event.senderId,
        themed: event.themed,
      };
    }
    case "tap_answered": {
      return {
        inboxId: event.inboxId,
        tapId: event.tapId,
        deviceId: event.deviceId,
        response: event.response,
      };
    }
    default: {
      return {
        ownerId: event.ownerId,
        ownerKind: event.ownerKind,
        creemEventId: event.creemEventId,
      };
    }
  }
};

/** The body PostHog's capture endpoint expects for one event. */
export const captureBody = Effect.fn(function* captureBody(
  projectToken: string,
  event: AnalyticsEvent,
  at: number,
  personId?: string
) {
  const { name } = event;
  const { person, fact } = identity(event);
  return {
    api_key: projectToken,
    event: name,
    distinct_id: personId ?? person,
    uuid: yield* stableUuid(`${name}:${fact}`),
    timestamp: new Date(at).toISOString(),
    properties: { ...eventProperties(event), $lib: "shouldertap-server" },
  };
});

/**
 * Sends one event. Never fails and gives up after a few seconds: analytics
 * must not break or slow the request that triggered it.
 */
export const capture = (
  projectToken: string,
  event: AnalyticsEvent,
  at: number,
  personId?: string
) =>
  captureBody(projectToken, event, at, personId).pipe(
    Effect.flatMap((body) =>
      Effect.tryPromise((signal) =>
        fetch(POSTHOG_CAPTURE_URL, {
          signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      )
    ),
    Effect.timeout("5 seconds"),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.void
        : Effect.logWarning("PostHog rejected an event", {
            event: event.name,
            status: response.status,
          })
    ),
    Effect.catchCause(() => Effect.logWarning("Couldn't reach PostHog"))
  );

/** Reports an event in the background; a no-op where analytics is off. */
export type Track = (
  event: AnalyticsEvent,
  at: number
) => Effect.Effect<void, never, RuntimeContext>;
