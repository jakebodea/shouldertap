import type { Plan } from "@shouldertap/domain";

/** Historical trial duration, retained for the old ledger and rollback data. */
export const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A Mac's trial end when it sets up an inbox at `at`. The first setup starts
 * a fresh trial; later ones keep the end already recorded, so setting up
 * again resumes the remaining days, or none if the trial has ended.
 */
export const claimTrial = (
  recorded: number | undefined,
  at: number
): { readonly trialEndsAt: number; readonly isNew: boolean } =>
  recorded === undefined
    ? { trialEndsAt: at + TRIAL_MS, isNew: true }
    : { trialEndsAt: recorded, isNew: false };

/** The plan-related columns of the inbox row. */
export interface PlanRow {
  readonly paidAt: number | null;
  readonly recipientName?: string;
  readonly trialEndsAt: number | null;
}

/** `paid` is a compatibility value so old desktops suppress their paywall.
 * It does not assert a purchase. Historical purchase columns remain intact. */
export const planOf = (row: PlanRow | undefined, at: number): Plan => ({
  status: "paid",
  trialEndsAt: row?.trialEndsAt ?? at,
});
