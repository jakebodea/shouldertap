import { describe, expect, it } from "vitest";

import {
  forgetIntent,
  membershipChoices,
  patronPlan,
  resolveIntent,
  styleOffer,
} from "./account-flow";

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
};

// 2026-10-21 12:00 UTC.
const noon = Date.UTC(2026, 9, 21, 12);
const minutes = (n: number) => n * 60 * 1000;

describe("patron intent across the sign-in round trip", () => {
  it("keeps the patron intent after the portal returns without a query", () => {
    const storage = memoryStorage();
    expect(resolveIntent(storage, "?intent=patron", noon)).toBe("patron");
    expect(resolveIntent(storage, "", noon + minutes(12))).toBe("patron");
  });

  it("drops an intent remembered more than an hour ago", () => {
    const storage = memoryStorage();
    resolveIntent(storage, "?intent=patron", noon);
    expect(resolveIntent(storage, "", noon + minutes(61))).toBeNull();
    expect(resolveIntent(storage, "", noon + minutes(1))).toBeNull();
  });

  it("forgets the intent once the sender continues", () => {
    const storage = memoryStorage();
    resolveIntent(storage, "?intent=patron", noon);
    forgetIntent(storage);
    expect(resolveIntent(storage, "", noon)).toBeNull();
    expect(resolveIntent(storage, "?intent=patron", noon)).toBe("patron");
  });
});

const paid = (id: string) => ({ id, active: true, canSubscribe: false });
const unpaid = (id: string) => ({ id, active: false, canSubscribe: true });
const paused = (id: string) => ({ id, active: false, canSubscribe: false });

describe("patron plan on this browser", () => {
  it("offers the account's active membership to a browser without one", () => {
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [paid("patronA")],
        checkoutEnabled: false,
      })
    ).toStrictEqual({ kind: "use", patronId: "patronA" });
  });

  it("offers checkout, not use, for a membership that was never paid", () => {
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [unpaid("patronA")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "checkout", patronId: "patronA" });
    expect(
      patronPlan({
        localPatronId: "patronA",
        memberships: [unpaid("patronA")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "checkout", patronId: "patronA" });
  });

  it("requires a choice when the account has several active memberships", () => {
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [paid("patronA"), paid("patronB")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "choose" });
    expect(
      patronPlan({
        localPatronId: "patronB",
        memberships: [paid("patronA"), paid("patronB")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "here" });
    expect(
      patronPlan({
        localPatronId: "patronC",
        memberships: [paid("patronA"), paid("patronB")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "kept", saved: false });
  });

  it("keeps an unpaid membership on this browser instead of replacing it", () => {
    expect(
      patronPlan({
        localPatronId: "patronA",
        memberships: [unpaid("patronA"), paid("patronB")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "kept", saved: true });
  });

  it("sends a paused membership to billing instead of a second checkout", () => {
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [paused("patronA")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "lapsed" });
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [unpaid("patronA"), paused("patronB")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "lapsed" });
  });

  it("uses the one active membership when another was never paid", () => {
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [unpaid("patronA"), paid("patronB")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "use", patronId: "patronB" });
  });

  it("recognizes the account's membership already on this browser", () => {
    expect(
      patronPlan({
        localPatronId: "patronA",
        memberships: [paid("patronA")],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "here" });
  });

  it("asks to save a browser membership the account doesn't have", () => {
    expect(
      patronPlan({
        localPatronId: "patronB",
        memberships: [],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "save" });
  });

  it("says memberships open soon while checkout is off", () => {
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [],
        checkoutEnabled: false,
      })
    ).toStrictEqual({ kind: "soon" });
    expect(
      patronPlan({
        localPatronId: null,
        memberships: [],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "checkout" });
  });
});

describe("Style's patron call to action", () => {
  it("never offers checkout until the server says it is open", () => {
    const fresh = { canManage: false, canSubscribe: true };
    expect(styleOffer({ ...fresh, checkoutEnabled: false })).toBe("soon");
    expect(styleOffer({ ...fresh, checkoutEnabled: null })).toBe("soon");
    expect(styleOffer({ ...fresh, checkoutEnabled: true })).toBe("subscribe");
  });

  it("sends a lapsed member with billing to manage it", () => {
    expect(
      styleOffer({
        canManage: true,
        canSubscribe: false,
        checkoutEnabled: false,
      })
    ).toBe("manage");
  });
});

describe("membership choice labels", () => {
  it("distinguishes memberships by billing status and paid period", () => {
    const choices = membershipChoices([
      {
        id: "a",
        name: "Patron membership",
        billing: { status: "active", paidUntil: Date.UTC(2027, 0, 1) },
      },
      {
        id: "b",
        name: "Patron membership",
        billing: { status: "inactive", paidUntil: null },
      },
    ]);
    expect(
      choices.map((choice) => ({
        detail: choice.detail,
        canChoose: choice.canChoose,
      }))
    ).toStrictEqual([
      { detail: "Active · Paid through Jan 1, 2027", canChoose: true },
      { detail: "Inactive", canChoose: true },
    ]);
  });

  it("does not offer indistinguishable memberships or missing billing facts", () => {
    const choices = membershipChoices([
      {
        id: "a",
        name: "Patron membership",
        billing: { status: "inactive", paidUntil: null },
      },
      {
        id: "b",
        name: "Patron membership",
        billing: { status: "inactive", paidUntil: null },
      },
      { id: "c", name: "Other membership" },
    ]);
    expect(
      choices.map((choice) => ({
        detail: choice.detail,
        canChoose: choice.canChoose,
      }))
    ).toStrictEqual([
      { detail: "Inactive", canChoose: false },
      { detail: "Inactive", canChoose: false },
      { detail: "Membership details unavailable", canChoose: false },
    ]);
  });
});
