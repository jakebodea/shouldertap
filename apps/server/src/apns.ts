import {
  describeResponse,
  type PushEnvironment,
  type Tap,
} from "@shouldertap/domain";
import * as Effect from "effect/Effect";

/**
 * Apple Push Notification service, for linked iPhones. The Worker signs the
 * provider token (it holds the key) and hands it to the Inbox, which builds
 * and sends the pushes for its taps.
 *
 * A tap reaches an iPhone one of two ways, by what the phone reported:
 * - Live Activities on, with a push-to-start token: start the tap's Live
 *   Activity (Lock Screen and Dynamic Island), with an alert.
 * - Otherwise: a Time Sensitive notification with On it / In 10 min / Reply.
 * Once the tap is answered anywhere, its Live Activity is ended (when the
 * phone sent us its token) and a background push tells the app to clear
 * anything left: the notification, or an activity we have no token for.
 */

/** The signed provider token the Inbox sends with every push. */
export interface PushContext {
  readonly jwt: string;
}

const PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1000;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encodeJson = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

/** The .p8 file's contents (PEM, PKCS #8) as DER bytes. */
const pemBytes = (pem: string) => {
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
};

/** An ES256 provider token: header `{alg, kid}`, claims `{iss, iat}`. */
export const signProviderToken = async (
  key: { readonly p8: string; readonly keyId: string; readonly teamId: string },
  at: number
) => {
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(key.p8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const input = `${encodeJson({ alg: "ES256", kid: key.keyId })}.${encodeJson({
    iss: key.teamId,
    iat: Math.floor(at / 1000),
  })}`;
  // WebCrypto signs ECDSA as raw r || s, which is what JWS wants.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
};

/**
 * Provider tokens are reused for 45 minutes (APNs accepts them for an hour
 * and refuses new ones more often than every 20 minutes), per isolate.
 */
export const makeProviderTokens = (key: {
  readonly p8: string;
  readonly keyId: string;
  readonly teamId: string;
}) => {
  let cached: { readonly jwt: string; readonly at: number } | undefined;
  return Effect.promise(async (): Promise<PushContext> => {
    const at = Date.now();
    if (!cached || at - cached.at > PROVIDER_TOKEN_TTL_MS) {
      cached = { jwt: await signProviderToken(key, at), at };
    }
    return { jwt: cached.jwt };
  });
};

// Requests

export type PushType = "alert" | "liveactivity" | "background";

export interface ApnsRequest {
  readonly collapseId?: string;
  readonly environment: PushEnvironment;
  readonly payload: Record<string, unknown>;
  /** 10 delivers now; background pushes must use 5. */
  readonly priority: 5 | 10;
  readonly pushType: PushType;
  readonly token: string;
  /** The bundle id; Live Activity pushes add `.push-type.liveactivity`. */
  readonly topic: string;
}

export interface ApnsResult {
  readonly reason?: string;
  readonly status: number;
}

/** The token is gone for good: forget it. */
export const isDeadToken = (result: ApnsResult) =>
  result.status === 410 ||
  (result.status === 400 &&
    (result.reason === "BadDeviceToken" ||
      result.reason === "DeviceTokenNotForTopic"));

const hosts: Record<PushEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** One push. Network failures come back as status 0, never as errors. */
export const sendPush = (context: PushContext, request: ApnsRequest) =>
  Effect.promise(async (): Promise<ApnsResult> => {
    const headers: Record<string, string> = {
      authorization: `bearer ${context.jwt}`,
      "apns-push-type": request.pushType,
      "apns-topic":
        request.pushType === "liveactivity"
          ? `${request.topic}.push-type.liveactivity`
          : request.topic,
      "apns-priority": String(request.priority),
      "content-type": "application/json",
    };
    if (request.collapseId) {
      headers["apns-collapse-id"] = request.collapseId;
    }
    try {
      const response = await fetch(
        `${hosts[request.environment]}/3/device/${request.token}`,
        { method: "POST", headers, body: JSON.stringify(request.payload) }
      );
      if (response.ok) {
        return { status: response.status };
      }
      const body = (await response.json().catch(() => ({}))) as {
        reason?: string;
      };
      return { status: response.status, reason: body.reason };
    } catch (error) {
      return { status: 0, reason: String(error) };
    }
  }).pipe(Effect.timeout("10 seconds"), Effect.orElseSucceed(timedOut));

const timedOut = (): ApnsResult => ({ status: 0, reason: "timeout" });

// Payloads. The Live Activity's attributes and content state must decode as
// `TapActivityAttributes` in apps/ios/TapActivity/TapActivity.swift.

const seconds = (ms: number) => Math.floor(ms / 1000);

const activityAttributes = (tap: Tap) => ({
  tapId: tap.id,
  senderName: tap.senderName,
  senderColor: tap.senderColor,
  createdAt: tap.createdAt,
});

const alert = (tap: Tap) => ({ title: tap.senderName, body: tap.body });

/** Starts the tap's Live Activity, lighting the Lock Screen or the island. */
export const startActivityPayload = (tap: Tap, at: number) => ({
  aps: {
    timestamp: seconds(at),
    event: "start",
    "attributes-type": "TapActivityAttributes",
    attributes: activityAttributes(tap),
    "content-state": { body: tap.body },
    alert: { ...alert(tap), sound: "default" },
    "relevance-score": 100,
  },
});

/** The notification for phones without Live Activities. */
export const notificationPayload = (tap: Tap) => ({
  aps: {
    alert: alert(tap),
    sound: "default",
    category: "tap",
    "interruption-level": "time-sensitive",
    "thread-id": tap.senderId,
  },
  tapId: tap.id,
  senderName: tap.senderName,
  senderColor: tap.senderColor,
  createdAt: tap.createdAt,
});

/** What an answered tap's ended activity says, e.g. "On it · Studio Mac". */
export const answerLabel = (tap: Tap) => {
  const label = tap.response ? describeResponse(tap.response) : "Answered";
  return tap.acknowledgedBy ? `${label} · ${tap.acknowledgedBy}` : label;
};

/** Ends an answered tap's Live Activity right away. */
export const endActivityPayload = (tap: Tap, at: number) => ({
  aps: {
    timestamp: seconds(at),
    event: "end",
    "content-state": { body: tap.body, answer: answerLabel(tap) },
    "dismissal-date": seconds(at),
  },
});

/** Wakes the app to clear what's left of an answered tap. */
export const resolvedPayload = (tap: Tap) => ({
  aps: { "content-available": 1 },
  resolvedTapId: tap.id,
});
