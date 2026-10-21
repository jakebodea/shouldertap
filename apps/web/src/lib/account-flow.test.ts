import { describe, expect, it } from "vitest";

import {
  forgetIntent,
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

describe("patron plan on this browser", () => {
  it("offers the account's membership to a browser without one", () => {
    expect(
      patronPlan({
        localPatronId: null,
        accountPatronIds: ["patronA"],
        checkoutEnabled: false,
      })
    ).toStrictEqual({ kind: "use", patronId: "patronA" });
  });

  it("keeps a different membership already on this browser", () => {
    expect(
      patronPlan({
        localPatronId: "patronB",
        accountPatronIds: ["patronA"],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "kept" });
  });

  it("recognizes the account's membership already on this browser", () => {
    expect(
      patronPlan({
        localPatronId: "patronA",
        accountPatronIds: ["patronA"],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "here" });
  });

  it("asks to save a browser membership the account doesn't have", () => {
    expect(
      patronPlan({
        localPatronId: "patronB",
        accountPatronIds: [],
        checkoutEnabled: true,
      })
    ).toStrictEqual({ kind: "save" });
  });

  it("says memberships open soon while checkout is off", () => {
    expect(
      patronPlan({
        localPatronId: null,
        accountPatronIds: [],
        checkoutEnabled: false,
      })
    ).toStrictEqual({ kind: "soon" });
    expect(
      patronPlan({
        localPatronId: null,
        accountPatronIds: [],
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
