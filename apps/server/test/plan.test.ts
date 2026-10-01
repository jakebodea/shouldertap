import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { claimTrial, planOf, requireActivePlan, TRIAL_MS } from "../src/plan";

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
    });
    expect(planOf({ trialEndsAt: null, paidAt: null }, NOW).status).toBe(
      "trial"
    );
  });
});

describe("claimTrial", () => {
  test("a Mac's first setup starts a fresh trial", () => {
    expect(claimTrial(undefined, NOW)).toEqual({
      trialEndsAt: NOW + TRIAL_MS,
      isNew: true,
    });
  });

  test("setting up again keeps the recorded end, even once it has passed", () => {
    expect(claimTrial(NOW + 1000, NOW + TRIAL_MS)).toEqual({
      trialEndsAt: NOW + 1000,
      isNew: false,
    });
    const reclaimed = claimTrial(NOW - 1, NOW);
    expect(
      planOf({ trialEndsAt: reclaimed.trialEndsAt, paidAt: null }, NOW).status
    ).toBe("expired");
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
