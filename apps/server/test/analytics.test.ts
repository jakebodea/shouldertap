import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  analyticsPerson,
  captureBody,
  patronEventName,
} from "../src/analytics";

const at = Date.UTC(2026, 9, 21, 17, 30);

const answer = (deviceId: string) =>
  Effect.runPromise(
    captureBody(
      "phc_test",
      {
        name: "tap_answered",
        inboxId: "inbox1",
        tapId: "tap123456",
        deviceId,
        response: "on_it",
      },
      at
    )
  );

describe("PostHog events", () => {
  it("reports a tap by its sender, with ids and no text", async () => {
    const event = {
      name: "tap_sent" as const,
      inboxId: "inbox1",
      tapId: "tap123456",
      senderId: "sender123",
      themed: false,
      email: "private@example.com",
      text: "A private message",
    };
    const body = await Effect.runPromise(captureBody("phc_test", event, at));
    expect(body).toStrictEqual({
      api_key: "phc_test",
      event: "tap_sent",
      distinct_id: "sender123",
      // SHA-256("tap_sent:tap123456") with UUID version/variant bits set.
      uuid: "142a9aa1-f236-82ab-83b7-534d9c74b5f3",
      timestamp: "2026-10-21T17:30:00.000Z",
      properties: {
        inboxId: "inbox1",
        tapId: "tap123456",
        senderId: "sender123",
        themed: false,
        $lib: "shouldertap-server",
      },
    });
  });

  it("sets a new account's email on its person and takes it off when deleted", async () => {
    const created = await Effect.runPromise(
      captureBody(
        "phc_test",
        {
          name: "account_created",
          userId: "acct1",
          email: "reader@example.com",
        },
        at
      )
    );
    const deleted = await Effect.runPromise(
      captureBody("phc_test", { name: "account_deleted", userId: "acct1" }, at)
    );
    expect([created.distinct_id, created.properties]).toStrictEqual([
      "acct1",
      {
        userId: "acct1",
        $set: { email: "reader@example.com" },
        $lib: "shouldertap-server",
      },
    ]);
    expect([
      deleted.event,
      deleted.distinct_id,
      deleted.properties,
    ]).toStrictEqual([
      "account_deleted",
      "acct1",
      { userId: "acct1", $unset: ["email"], $lib: "shouldertap-server" },
    ]);
  });

  it("gives every device's answer to one tap the same identity, so PostHog keeps one", async () => {
    const [mac, iphone] = await Promise.all([answer("mac1"), answer("phone1")]);
    expect([mac.distinct_id, mac.uuid]).toStrictEqual([
      "inbox1",
      "65b67e24-b77f-88ba-b8c2-72c55abca442",
    ]);
    expect([iphone.distinct_id, iphone.uuid]).toStrictEqual([
      "inbox1",
      "65b67e24-b77f-88ba-b8c2-72c55abca442",
    ]);
  });

  it("links sending, answering and billing to the verified account owner", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE account_resource (kind TEXT, id TEXT, user_id TEXT);
        INSERT INTO account_resource VALUES ('sender', 'inbox1:sender1', 'sam'),
        ('inbox', 'inbox1', 'ari'), ('patron', 'patron1', 'sam');`);
      const db = {
        prepare: (sql: string) => ({
          bind: (...values: string[]) => ({
            first: () =>
              Promise.resolve(sqlite.prepare(sql).get(...values) ?? null),
          }),
        }),
      } as unknown as D1Database;
      const sender = await analyticsPerson(db, {
        name: "tap_sent",
        inboxId: "inbox1",
        tapId: "tap1",
        senderId: "sender1",
        themed: false,
      });
      const recipient = await analyticsPerson(db, {
        name: "tap_answered",
        inboxId: "inbox1",
        tapId: "tap1",
        deviceId: "mac1",
        response: "on_it",
      });
      const patron = await analyticsPerson(db, {
        name: "patron_paid",
        ownerId: "patron1",
        ownerKind: "patron",
        creemEventId: "evt1",
      });
      const unclaimed = await analyticsPerson(db, {
        name: "tap_sent",
        inboxId: "inbox1",
        tapId: "tap2",
        senderId: "guest1",
        themed: false,
      });
      expect([sender, recipient, patron, unclaimed]).toStrictEqual([
        "sam",
        "ari",
        "sam",
        "guest1",
      ]);
      const body = await Effect.runPromise(
        captureBody(
          "phc_test",
          {
            name: "tap_sent",
            inboxId: "inbox1",
            tapId: "tap1",
            senderId: "sender1",
            themed: false,
          },
          at,
          sender
        )
      );
      expect(body.distinct_id).toBe("sam");
    } finally {
      sqlite.close();
    }
  });

  it("names the Creem facts worth reporting and skips the rest", () => {
    expect(
      [
        "subscription.active",
        "subscription.paid",
        "subscription.scheduled_cancel",
        "subscription.canceled",
        "refund.created",
        "subscription.past_due",
        "toString",
      ].map(patronEventName)
    ).toStrictEqual([
      "patron_subscribed",
      "patron_paid",
      "patron_cancel_scheduled",
      "patron_canceled",
      "patron_refunded",
      null,
      null,
    ]);
  });
});
