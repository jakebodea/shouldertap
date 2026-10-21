import { describe, expect, it } from "vitest";

import { migrateBillingRefusal } from "../apps/web/src/lib/outbox-migration";

describe("saved billing refusals", () => {
  it("retires a saved trial refusal without silently sending or losing the message", () => {
    const migrated = migrateBillingRefusal({
      requestId: "request-1",
      body: "Dinner's ready",
      createdAt: 1_791_331_200_000,
      failed: true,
      paused: true,
      error: "Jake's trial has ended",
    });
    expect(migrated).toStrictEqual({
      requestId: "request-1",
      body: "Dinner's ready",
      createdAt: 1_791_331_200_000,
      failed: true,
      paused: false,
      error: "This message wasn't sent. Try again when you're ready.",
    });
  });
});
