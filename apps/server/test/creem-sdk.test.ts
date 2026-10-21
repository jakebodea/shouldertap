import { CreemCore } from "creem/core.js";
import { HTTPClient } from "creem/lib/http.js";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  createCheckout,
  customerPortal,
  validatePatronProduct,
  readWebhookAction,
  retrieveCheckout,
} from "../src/Creem";

/** Only the external HTTP boundary is fake; use the installed Creem 1.13 SDK. */
const sdk = (respond: (request: Request) => Promise<unknown>) =>
  new CreemCore({
    apiKey: "creem_test_not-a-credential",
    server: "test",
    retryConfig: { strategy: "none" },
    httpClient: new HTTPClient({
      fetcher: async (input) => {
        const value = await respond(input as Request);
        return Response.json(value);
      },
    }),
  });

const product = {
  id: "prod_patron",
  mode: "test",
  object: "product",
  name: "Shouldertap patron",
  description: "Optional annual support",
  price: 2400,
  currency: "USD",
  billing_type: "recurring",
  billing_period: "every-year",
  status: "active",
  tax_mode: "exclusive",
  tax_category: "saas",
  created_at: "2026-10-21T00:00:00Z",
  updated_at: "2026-10-21T00:00:00Z",
};

describe("Creem SDK boundary", () => {
  it("validates the annual USD product and refuses the old one-time product", async () => {
    const annual = sdk(() => Promise.resolve(product));
    const result = await Effect.runPromise(
      validatePatronProduct(annual, "prod_patron").pipe(
        Effect.as("annual USD 24")
      )
    );
    expect(result).toBe("annual USD 24");
    const legacy = sdk(() =>
      Promise.resolve({
        ...product,
        price: 500,
        billing_type: "onetime",
        billing_period: "once",
      })
    );
    const failure = await Effect.runPromise(
      validatePatronProduct(legacy, "prod_patron").pipe(Effect.flip)
    );
    expect(failure.message).toBe("Annual support is not configured correctly");
  });

  it("sends the real checkout API snake-case metadata and request correlation", async () => {
    let requestBody: unknown;
    const client = sdk(async (request) => {
      requestBody = await request.json();
      return {
        id: "ch_1",
        mode: "test",
        object: "checkout",
        status: "pending",
        product: "prod_patron",
        checkout_url: "https://creem.io/test-checkout",
      };
    });
    const result = await Effect.runPromise(
      createCheckout(client, {
        productId: "prod_patron",
        inboxId: "inbox123",
        requestId: "attempt-1",
      })
    );
    expect(result).toStrictEqual({
      id: "ch_1",
      url: "https://creem.io/test-checkout",
    });
    expect(requestBody).toStrictEqual({
      product_id: "prod_patron",
      request_id: "attempt-1",
      metadata: { inbox_id: "inbox123" },
    });
  });

  it("creates the supported hosted billing portal link for the authenticated customer", async () => {
    let seen: unknown;
    const client = sdk(async (request) => {
      seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
      };
      return { customer_portal_link: "https://creem.io/portal/test" };
    });
    const result = await Effect.runPromise(customerPortal(client, "cust_1"));
    expect(result).toBe("https://creem.io/portal/test");
    expect(seen).toStrictEqual({
      method: "POST",
      path: "/v1/customers/billing",
      body: { customer_id: "cust_1" },
    });
  });
});

describe("refund and checkout recovery", () => {
  it("hydrates a bare subscription id through the supported API before routing a refund", async () => {
    const client = sdk(() =>
      Promise.resolve({
        id: "sub_1",
        mode: "test",
        object: "subscription",
        product: "prod_patron",
        customer: "cust_1",
        collection_method: "charge_automatically",
        status: "canceled",
        created_at: "2026-10-21T00:00:00Z",
        updated_at: "2026-10-21T00:00:00Z",
        metadata: { inbox_id: "inbox123" },
      })
    );
    const body = JSON.stringify({
      id: "evt_ref",
      eventType: "refund.created",
      created_at: 1_792_540_800_000,
      object: {
        status: "succeeded",
        subscription: "sub_1",
        transaction: { id: "tran_1" },
      },
    });
    const action = await Effect.runPromise(
      readWebhookAction(client, body, "prod_legacy", "prod_patron")
    );
    expect(action).toMatchObject({
      kind: "patron",
      inboxId: "inbox123",
      subscriptionId: "sub_1",
      event: {
        type: "refund.created",
        refundTransactionId: "tran_1",
        customerId: "cust_1",
      },
    });
  });

  it("uses provider checkout status instead of guessing an expiration time", async () => {
    const client = sdk(() =>
      Promise.resolve({
        id: "ch_1",
        mode: "test",
        object: "checkout",
        status: "expired",
        product: "prod_patron",
      })
    );
    const state = await Effect.runPromise(retrieveCheckout(client, "ch_1"));
    expect(state.status).toBe("expired");
  });
});
