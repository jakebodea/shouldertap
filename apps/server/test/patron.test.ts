import { describe, expect, it } from "vitest";

import { patronOf } from "../src/patron";
import type { PatronEvent } from "../src/patron";

const NOW = Date.UTC(2026, 9, 21);
const paid: PatronEvent = {
  id: "evt_paid",
  at: NOW,
  type: "subscription.paid",
  subscriptionId: "sub_1",
  customerId: "cust_1",
  periodEnd: Date.UTC(2027, 9, 21),
  transactionId: "tran_1",
  refundTransactionId: null,
};
const fact = (change: Partial<PatronEvent>): PatronEvent => ({
  ...paid,
  ...change,
});

describe("annual patron lifecycle", () => {
  it("activates only on paid, expires at the exact paid boundary", () => {
    expect(
      patronOf([fact({ type: "subscription.active" })], NOW).active
    ).toBeFalsy();
    expect(patronOf([paid], NOW)).toStrictEqual({
      active: true,
      status: "active",
      paidUntil: 1_824_076_800_000,
      canManage: true,
      canSubscribe: false,
      legacySupporter: false,
    });
    expect(patronOf([paid], Date.UTC(2027, 9, 21)).active).toBeFalsy();
  });

  it("scheduled cancellation preserves the paid period despite duplicate and late paid events", () => {
    const cancellation = fact({
      id: "evt_cancel",
      type: "subscription.scheduled_cancel",
      at: NOW + 1000,
    });
    expect(patronOf([cancellation, paid, paid], NOW + 2000).status).toBe(
      "ending"
    );
    expect(
      patronOf([paid, cancellation], Date.UTC(2027, 9, 21)).active
    ).toBeFalsy();
  });

  it("payment failure does not extend a paid period and a paid renewal recovers", () => {
    const failed = fact({
      id: "evt_fail",
      type: "subscription.unpaid",
      at: NOW + 2000,
      periodEnd: Date.UTC(2028, 9, 21),
    });
    expect(patronOf([failed, paid], NOW + 3000).status).toBe("payment_issue");
    expect(patronOf([paid, failed], Date.UTC(2027, 9, 21)).active).toBeFalsy();
    const renewal = fact({
      id: "evt_renew",
      at: Date.UTC(2027, 9, 21),
      transactionId: "tran_2",
      periodEnd: Date.UTC(2028, 9, 21),
    });
    expect(
      patronOf([renewal, failed, paid], Date.UTC(2027, 9, 22)).paidUntil
    ).toBe(1_855_699_200_000);
  });

  it("refund before paid cannot resurrect support; refund of an old payment does not remove a renewal", () => {
    const refund = fact({
      id: "evt_refund",
      type: "refund.created",
      at: NOW + 1000,
      refundTransactionId: "tran_1",
    });
    expect(patronOf([refund, paid], NOW + 2000).active).toBeFalsy();
    const renewal = fact({
      id: "evt_renew",
      at: NOW + 3000,
      transactionId: "tran_2",
      periodEnd: Date.UTC(2028, 9, 21),
    });
    expect(patronOf([refund, renewal, paid], NOW + 4000).active).toBeTruthy();
  });

  it("a refunded payment replay with a new event identity cannot overwrite cancellation", () => {
    const canceled = fact({
      id: "evt_canceled",
      type: "subscription.canceled",
      at: NOW + 1000,
    });
    const refund = fact({
      id: "evt_refund",
      type: "refund.created",
      at: NOW + 2000,
      refundTransactionId: "tran_1",
    });
    const replay = fact({ id: "evt_replayed_paid", at: NOW + 3000 });
    expect(
      patronOf([paid, canceled, refund, replay], NOW + 4000)
    ).toStrictEqual({
      active: false,
      status: "inactive",
      paidUntil: 0,
      canManage: true,
      canSubscribe: true,
      legacySupporter: false,
    });
  });

  it("old subscriptions cannot overwrite another active membership and completed cancellation allows subscribing again", () => {
    const old = fact({
      id: "evt_old",
      subscriptionId: "sub_old",
      type: "subscription.canceled",
      at: NOW + 4000,
    });
    expect(patronOf([paid, old], NOW + 5000).status).toBe("active");
    expect(
      patronOf(
        [
          paid,
          fact({
            id: "evt_done",
            type: "subscription.canceled",
            at: NOW + 1000,
          }),
        ],
        Date.UTC(2027, 9, 22)
      ).canSubscribe
    ).toBeTruthy();
  });
});
