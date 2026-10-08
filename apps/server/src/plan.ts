import { PaymentRequired } from "@shouldertap/domain";
import type { Plan } from "@shouldertap/domain";
import * as Effect from "effect/Effect";

/** How long a new inbox delivers taps before it needs paying for. */
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

/**
 * The inbox's plan as of `at`. A row without a trial end (or no row yet) is
 * treated as a trial starting now, so a missing value never locks anyone out.
 */
export const planOf = (row: PlanRow | undefined, at: number): Plan => {
  const trialEndsAt = row?.trialEndsAt ?? at + TRIAL_MS;
  if ((row?.paidAt ?? null) !== null) {
    return { status: "paid", trialEndsAt };
  }
  return { status: at < trialEndsAt ? "trial" : "expired", trialEndsAt };
};

/** What a sender sees when the recipient's trial has ended. */
export const pausedMessage = (recipientName: string | undefined) =>
  `${recipientName || "This person"}'s Shouldertap trial has ended, so taps are paused.`;

/** Fails with PaymentRequired once the trial has ended unpaid. */
export const requireActivePlan = (row: PlanRow | undefined, at: number) =>
  planOf(row, at).status === "expired"
    ? Effect.fail(
        new PaymentRequired({ message: pausedMessage(row?.recipientName) })
      )
    : Effect.void;
