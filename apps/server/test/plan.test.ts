import { describe, expect, it } from "@effect/vitest";

import { claimTrial, planOf } from "../src/plan";

const NOW = Date.UTC(2026, 9, 21);
describe("free core compatibility", () => {
  it("every historical billing state emits the old-client unlocked value", () => {
    for (const row of [
      undefined,
      { trialEndsAt: null, paidAt: null },
      { trialEndsAt: 1, paidAt: null },
      { trialEndsAt: 9_999_999_999_999, paidAt: null },
      { trialEndsAt: 1, paidAt: 2 },
    ]) {
      expect(planOf(row, NOW).status).toBe("paid");
    }
  });

  it("retains the trial ledger for rollback without enforcing it", () => {
    expect(claimTrial(1, NOW)).toStrictEqual({ trialEndsAt: 1, isNew: false });
    expect(planOf({ trialEndsAt: 1, paidAt: null }, NOW)).toStrictEqual({
      status: "paid",
      trialEndsAt: 1,
    });
  });
});
