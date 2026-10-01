import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { INBOX_METADATA_KEY, verifyWebhook, webhookAction } from "../src/Creem";

const PRODUCT = "prod_shouldertap";

const checkoutCompleted = (product = PRODUCT) =>
  JSON.stringify({
    id: "evt_1",
    eventType: "checkout.completed",
    created_at: 1_790_000_000_000,
    object: {
      id: "ch_1",
      object: "checkout",
      order: { id: "ord_1", product, status: "paid" },
      product: { id: product },
      customer: { id: "cust_1", email: "buyer@example.com" },
      metadata: { [INBOX_METADATA_KEY]: "inbox123" },
    },
  });

const refundCreated = (checkout: unknown) =>
  JSON.stringify({
    id: "evt_2",
    eventType: "refund.created",
    created_at: 1_790_000_000_000,
    object: { id: "ref_1", order: { id: "ord_1" }, checkout },
  });

describe("webhookAction", () => {
  test("a completed checkout for our product is a purchase", () => {
    expect(webhookAction(checkoutCompleted(), PRODUCT)).toEqual({
      kind: "purchase",
      inboxId: "inbox123",
      orderId: "ord_1",
      email: "buyer@example.com",
    });
  });

  test("other products on the store are ignored", () => {
    expect(webhookAction(checkoutCompleted("prod_other"), PRODUCT).kind).toBe(
      "ignore"
    );
  });

  test("a refund carries the inbox when the checkout is expanded", () => {
    const checkout = {
      id: "ch_1",
      metadata: { [INBOX_METADATA_KEY]: "inbox123" },
    };
    expect(webhookAction(refundCreated(checkout), PRODUCT)).toEqual({
      kind: "refund",
      orderId: "ord_1",
      inboxId: "inbox123",
      checkoutId: "ch_1",
    });
  });

  test("a refund with a bare checkout id needs a lookup", () => {
    expect(webhookAction(refundCreated("ch_1"), PRODUCT)).toEqual({
      kind: "refund",
      orderId: "ord_1",
      inboxId: null,
      checkoutId: "ch_1",
    });
  });

  test("other events are ignored", () => {
    const body = JSON.stringify({
      id: "evt_3",
      eventType: "subscription.paid",
      object: {},
    });
    expect(webhookAction(body, PRODUCT).kind).toBe("ignore");
  });
});

/** Creem's `creem-signature`: hex HMAC-SHA256 of the raw body. */
const sign = async (body: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  return Buffer.from(mac).toString("hex");
};

describe("verifyWebhook", () => {
  const body = checkoutCompleted();

  test("accepts the right signature", async () => {
    const signature = await sign(body, "whsec_test");
    await Effect.runPromise(
      verifyWebhook(body, { "creem-signature": signature }, "whsec_test")
    );
  });

  test("rejects a wrong secret or a changed body", async () => {
    const signature = await sign(body, "whsec_other");
    const wrongSecret = await Effect.runPromise(
      Effect.flip(
        verifyWebhook(body, { "creem-signature": signature }, "whsec_test")
      )
    );
    expect(wrongSecret._tag).toBe("CreemError");
    const good = await sign(body, "whsec_test");
    const tampered = await Effect.runPromise(
      Effect.flip(
        verifyWebhook(`${body} `, { "creem-signature": good }, "whsec_test")
      )
    );
    expect(tampered._tag).toBe("CreemError");
  });
});
