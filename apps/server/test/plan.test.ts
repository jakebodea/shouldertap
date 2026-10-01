import { describe, expect, test } from "bun:test";
import { FULL_PRICE_CENTS, TRIAL_PRICE_CENTS } from "@shouldertap/domain";
import * as Effect from "effect/Effect";

import { planOf, requireActivePlan, TRIAL_MS } from "../src/plan";

const NOW = Date.UTC(2026, 9, 1);

describe("planOf", () => {
  test("a trial runs until its end, then expires", () => {
    const row = { trialEndsAt: NOW + 1000, paidAt: null };
    expect(planOf(row, NOW).status).toBe("trial");
    expect(planOf(row, NOW + 999).status).toBe("trial");
    expect(planOf(row, NOW + 1000).status).toBe("expired");
  });

  test("paying unlocks, during or after the trial", () => {
    expect(planOf({ trialEndsAt: NOW + 1000, paidAt: NOW }, NOW).status).toBe(
      "paid"
    );
    expect(
      planOf({ trialEndsAt: NOW - TRIAL_MS, paidAt: NOW }, NOW + 1).status
    ).toBe("paid");
  });

  test("a missing trial end is a fresh trial, never expired", () => {
    expect(planOf(undefined, NOW)).toEqual({
      status: "trial",
      trialEndsAt: NOW + TRIAL_MS,
      unlockPrice: TRIAL_PRICE_CENTS,
    });
    expect(planOf({ trialEndsAt: null, paidAt: null }, NOW).status).toBe(
      "trial"
    );
  });
});

describe("unlock price", () => {
  test("is the trial price during the trial and the full price after", () => {
    const row = { trialEndsAt: NOW + 1000, paidAt: null };
    expect(planOf(row, NOW).unlockPrice).toBe(TRIAL_PRICE_CENTS);
    expect(planOf(row, NOW + 1000).unlockPrice).toBe(FULL_PRICE_CENTS);
    expect(TRIAL_PRICE_CENTS).toBe(500);
    expect(FULL_PRICE_CENTS).toBe(1000);
  });
});

describe("requireActivePlan", () => {
  test("an expired trial refuses taps with the recipient's name", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        requireActivePlan(
          { trialEndsAt: NOW, paidAt: null, recipientName: "Jake" },
          NOW
        )
      )
    );
    expect(error._tag).toBe("PaymentRequired");
    expect(error.message).toBe(
      "Jake's Shouldertap trial has ended, so taps are paused."
    );
  });

  test("a trial or a paid inbox lets taps through", async () => {
    await Effect.runPromise(
      requireActivePlan({ trialEndsAt: NOW + 1, paidAt: null }, NOW)
    );
    await Effect.runPromise(
      requireActivePlan({ trialEndsAt: NOW - 1, paidAt: NOW - 2 }, NOW)
    );
  });
});
