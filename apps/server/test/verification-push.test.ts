import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";

import type { Tap } from "@shouldertap/domain";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isDeadToken,
  notificationPayload,
  sendPush,
  startActivityPayload,
} from "../src/apns";
import type { ApnsRequest } from "../src/apns";
import {
  stageRateLimitKey,
  verificationRateLimitKey,
  verificationResponse,
} from "../src/verification-mail";

const token = "verification-push-secret-at-least-32-characters";
const url = "https://api.verify.example/__verify/push";
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
let sqlite: DatabaseSync;
let database: D1Database;
const context = { jwt: "verification-only", verification: { url, token } };
const route = (request: Request) =>
  verificationResponse(request, { database, token });
// Only the network boundary is adapted; real payload, headers and SQL run together.
const transport = (input: string, init: RequestInit) =>
  route(new Request(String(input), init));
const control = (method = "GET", body?: unknown, bearer = token) =>
  route(
    new Request(url, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
const alertRequest: ApnsRequest = {
  environment: "sandbox",
  topic: "app.shouldertap.iphone",
  token: "test-device-token",
  priority: 10,
  pushType: "alert",
  collapseId: "tap123456",
  payload: notificationPayload(tap),
};

describe("verification APNs boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      readFileSync(
        new URL(
          "../src/verification-migrations/0002_push.sql",
          import.meta.url
        ),
        "utf-8"
      )
    );
    const prepare = (sql: string, args: never[] = []) => ({
      bind: (...bound: never[]) => prepare(sql, bound),
      first: () => Promise.resolve(sqlite.prepare(sql).get(...args) ?? null),
      all: () => Promise.resolve({ results: sqlite.prepare(sql).all(...args) }),
      run: () => Promise.resolve(sqlite.prepare(sql).run(...args)),
    });
    database = {
      prepare,
      batch: (statements: { run: () => Promise<unknown> }[]) =>
        Promise.all(statements.map((statement) => statement.run())),
    } as unknown as D1Database;
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  it("captures the application's actual notification headers and payload without an Apple key", async () => {
    const result = await Effect.runPromise(
      sendPush(context, alertRequest, transport)
    );
    expect(result).toStrictEqual({ status: 200 });
    const captured = await control();
    const body = await captured.json();
    expect(body).toStrictEqual({
      pushes: [
        {
          id: 1,
          token: "test-device-token",
          environment: "sandbox",
          status: 200,
          headers: {
            "apns-topic": "app.shouldertap.iphone",
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-collapse-id": "tap123456",
          },
          payload: {
            aps: {
              alert: { title: "Maya", body: "Dinner's ready" },
              sound: "default",
              category: "tap",
              "interruption-level": "time-sensitive",
              "thread-id": "sender123",
            },
            tapId: "tap123456",
            senderName: "Maya",
            senderColor: "tomato",
            createdAt: 1_790_790_000_000,
          },
        },
      ],
    });
  });

  it("uses the Live Activity topic and propagates a simulated dead-token provider result", async () => {
    const configured = await control("PUT", {
      status: 410,
      reason: "Unregistered",
    });
    expect(configured.status).toBe(200);
    const result = await Effect.runPromise(
      sendPush(
        context,
        {
          ...alertRequest,
          pushType: "liveactivity",
          payload: startActivityPayload(tap, 1_790_790_005_000),
        },
        transport
      )
    );
    expect(result).toStrictEqual({ status: 410, reason: "Unregistered" });
    expect(isDeadToken(result)).toBeTruthy();
    const captured = await control();
    await expect(captured.json()).resolves.toMatchObject({
      pushes: [
        {
          headers: {
            "apns-topic": "app.shouldertap.iphone.push-type.liveactivity",
            "apns-push-type": "liveactivity",
          },
          payload: {
            aps: {
              event: "start",
              timestamp: 1_790_790_005,
              "attributes-type": "TapActivityAttributes",
              "content-state": { body: "Dinner's ready" },
            },
          },
          status: 410,
          reason: "Unregistered",
        },
      ],
    });
  });

  it("rejects another run's token and resets the simulator response on cleanup", async () => {
    const denied = await control("GET", undefined, "another-run");
    expect(denied.status).toBe(404);
    await control("PUT", { status: 503, reason: "ServiceUnavailable" });
    const cleared = await control("DELETE");
    await expect(cleared.json()).resolves.toStrictEqual({ cleared: true });
    const result = await Effect.runPromise(
      sendPush(context, alertRequest, transport)
    );
    expect(result).toStrictEqual({ status: 200 });
    const captured = await control();
    await expect(captured.json()).resolves.toMatchObject({
      pushes: [{ id: 1, status: 200 }],
    });
  });

  it("allows only an authenticated verification runner to simulate a separate client", () => {
    const headers = {
      "x-shouldertap-verification-client": "flood-a1",
      "x-shouldertap-verification-token": token,
    };
    expect([
      verificationRateLimitKey(
        "verify-loyw3v28-012345abcdef",
        "192.0.2.1",
        headers,
        token
      ),
      verificationRateLimitKey(
        "verify-loyw3v28-012345abcdef",
        "192.0.2.1",
        headers,
        "wrong-token"
      ),
      verificationRateLimitKey("prod", "192.0.2.1", headers, token),
      verificationRateLimitKey(
        "verify-loyw3v28-012345abcdef",
        "192.0.2.1",
        {},
        token
      ),
    ]).toStrictEqual([
      "verify-loyw3v28-012345abcdef:verification:flood-a1",
      "verify-loyw3v28-012345abcdef:192.0.2.1",
      "prod:192.0.2.1",
      "verify-loyw3v28-012345abcdef:192.0.2.1",
    ]);
  });

  it("keeps the actual limiter key separate for every stage and address", () => {
    expect(stageRateLimitKey("verify-loyw3v28-012345abcdef", "192.0.2.1")).toBe(
      "verify-loyw3v28-012345abcdef:192.0.2.1"
    );
    expect(stageRateLimitKey("verify-a2", "192.0.2.1")).toBe(
      "verify-a2:192.0.2.1"
    );
    expect(stageRateLimitKey("prod", "192.0.2.2")).toBe("prod:192.0.2.2");
  });
});
