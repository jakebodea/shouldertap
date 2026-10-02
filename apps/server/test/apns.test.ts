import { describe, expect, test } from "bun:test";
import type { Tap } from "@shouldertap/domain";

import {
  answeredNotificationPayload,
  answerLabel,
  endActivityPayload,
  isDeadToken,
  notificationPayload,
  signProviderToken,
  startActivityPayload,
} from "../src/apns";

const tap: Tap = {
  id: "tap123456",
  senderId: "sender123",
  senderName: "Maya",
  senderColor: "tomato",
  body: "Dinner's ready",
  createdAt: 1_790_790_000_000,
  state: "pending",
  displayedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  response: null,
  sequence: 4,
};

const decode = (part: string) =>
  JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));

describe("provider token", () => {
  test("is an ES256 JWT that verifies with the key's public half", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer
    );
    const p8 = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;

    const jwt = await signProviderToken(
      { p8, keyId: "ABC123DEFG", teamId: "6C46GY4Z38" },
      1_790_790_000_000
    );
    const [header, claims, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(decode(header)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decode(claims)).toEqual({ iss: "6C46GY4Z38", iat: 1_790_790_000 });

    const raw = Uint8Array.from(
      atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      raw,
      new TextEncoder().encode(`${header}.${claims}`)
    );
    expect(valid).toBe(true);
  });
});

describe("payloads", () => {
  test("a Live Activity start carries the attributes the app decodes", () => {
    const payload = startActivityPayload(tap, 1_790_790_005_000);
    expect(payload.aps.event).toBe("start");
    expect(payload.aps.timestamp).toBe(1_790_790_005);
    expect(payload.aps["attributes-type"]).toBe("TapActivityAttributes");
    expect(payload.aps.attributes).toEqual({
      tapId: "tap123456",
      senderName: "Maya",
      senderColor: "tomato",
      createdAt: 1_790_790_000_000,
    });
    expect(payload.aps["content-state"]).toEqual({ body: "Dinner's ready" });
    expect(payload.aps.alert).toEqual({
      title: "Maya",
      body: "Dinner's ready",
      sound: "default",
    });
  });

  test("the notification is Time Sensitive with the tap's actions", () => {
    const payload = notificationPayload(tap);
    expect(payload.aps.category).toBe("tap");
    expect(payload.aps["interruption-level"]).toBe("time-sensitive");
    expect(payload.tapId).toBe("tap123456");
  });

  test("an answered tap ends with who answered and how", () => {
    const answered: Tap = {
      ...tap,
      state: "acknowledged",
      acknowledgedBy: "Studio Mac",
      response: { kind: "on_it" },
    };
    expect(answerLabel(answered)).toBe("On it · Studio Mac");
    const payload = endActivityPayload(answered, 1_790_790_009_000);
    expect(payload.aps.event).toBe("end");
    expect(payload.aps["dismissal-date"]).toBe(1_790_790_009);
    expect(payload.aps["content-state"].answer).toBe("On it · Studio Mac");
  });

  test("an answered notification is replaced quietly", () => {
    const answered: Tap = {
      ...tap,
      state: "acknowledged",
      acknowledgedBy: "Studio Mac",
      response: { kind: "in_10" },
    };
    const payload = answeredNotificationPayload(answered);
    expect(payload.aps["interruption-level"]).toBe("passive");
    expect(payload.aps.alert.body).toBe("Answered: In 10 min · Studio Mac");
    expect("sound" in payload.aps).toBe(false);
    expect(payload.tapId).toBe("tap123456");
  });

  test("dead tokens are recognized", () => {
    expect(isDeadToken({ status: 410 })).toBe(true);
    expect(isDeadToken({ status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(isDeadToken({ status: 400, reason: "BadTopic" })).toBe(false);
    expect(isDeadToken({ status: 0, reason: "timeout" })).toBe(false);
  });
});
