import { PaymentRequired, type Plan } from "@shouldertap/domain";
import * as Effect from "effect/Effect";

/** How long a new inbox delivers taps before it needs paying for. */
export const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

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
