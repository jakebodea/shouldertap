import type { Patron } from "@shouldertap/domain";

/** Signed Creem facts, retained separately from historical one-time purchases. */
export interface PatronEvent {
  id: string;
  at: number;
  type: string;
  subscriptionId: string;
  customerId: string;
  periodEnd: number;
  transactionId: string | null;
  refundTransactionId: string | null;
}

/** Replaying facts makes late deliveries and duplicates converge, including a
 * refund arriving before the corresponding paid event. Only paid extends support.
 * A refund removes that transaction's support, not a later renewal's. */
const eventPriority = (type: string) => {
  if (type === "subscription.paid") {
    return 0;
  }
  if (type === "subscription.active") {
    return 1;
  }
  if (type === "subscription.scheduled_cancel") {
    return 3;
  }
  if (type === "subscription.canceled") {
    return 4;
  }
  return 2;
};

const supportStatus = (status: string): Patron["status"] => {
  if (status === "scheduled_cancel" || status === "canceled") {
    return "ending";
  }
  if (status === "past_due" || status === "unpaid") {
    return "payment_issue";
  }
  return "active";
};

export const patronOf = (
  events: readonly PatronEvent[],
  at: number,
  legacySupporter = false
): Patron => {
  const refunds = new Set(
    events
      .filter((e) => e.type === "refund.created")
      .map((e) => e.refundTransactionId)
  );
  const ordered = events.toSorted(
    (a, b) =>
      a.at - b.at ||
      eventPriority(a.type) - eventPriority(b.type) ||
      a.id.localeCompare(b.id)
  );
  const subscriptions = new Map<string, { until: number; status: string }>();
  for (const event of ordered) {
    const current = subscriptions.get(event.subscriptionId) ?? {
      until: 0,
      status: "unknown",
    };
    if (event.type !== "refund.created") {
      current.status = event.type.slice("subscription.".length);
    }
    if (
      event.type === "subscription.paid" &&
      event.transactionId &&
      !refunds.has(event.transactionId)
    ) {
      current.until = Math.max(current.until, event.periodEnd);
    }
    subscriptions.set(event.subscriptionId, current);
  }
  const current = [...subscriptions.values()].toSorted(
    (a, b) => b.until - a.until
  );
  const active = current.find((s) => s.until > at && s.status !== "paused");
  let status: Patron["status"] = current.length > 0 ? "inactive" : "none";
  if (active) {
    status = supportStatus(active.status);
  }
  return {
    active: !!active,
    legacySupporter,
    canSubscribe: !active && current.every((s) => s.status === "canceled"),
    status,
    paidUntil: active?.until ?? current[0]?.until ?? null,
    canManage: current.length > 0,
  };
};

export interface PromptHistory {
  firstAnsweredAt: number | null;
  answeredCount: number;
  supportAskAfter: number;
}
/** Recipient only; claim is atomic in the Inbox and consumes a 90-day cooldown. */
export const promptEligible = (
  history: PromptHistory,
  patron: Patron,
  pending: boolean,
  at: number
) =>
  !patron.active &&
  !patron.canManage &&
  !patron.legacySupporter &&
  !pending &&
  history.answeredCount >= 10 &&
  history.firstAnsweredAt !== null &&
  at >= history.firstAnsweredAt + 14 * 86_400_000 &&
  at >= history.supportAskAfter;
export const nextSupportAsk = (at: number) => at + 90 * 86_400_000;
