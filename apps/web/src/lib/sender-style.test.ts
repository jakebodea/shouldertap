import { ApiError } from "@shouldertap/client";
import type { AccountConnection, Profile } from "@shouldertap/client";
import type { TapTheme } from "@shouldertap/domain";
import { describe, expect, it } from "vitest";

import type { Pairing } from "./pairing";
import { chooseStyle, styleFor } from "./sender-style";

/** The browser's storage boundary, in memory. */
const memoryStorage = (seed: Record<string, string> = {}) => {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

/** `/account/send-profile`, in memory: `held` are the connections the
 * account owns; any other id is 404 "No such person". */
const fakeAccount = (held: readonly string[]) => {
  const saved: AccountConnection[] = [];
  const save = (
    id: string,
    profile: Profile & { readonly theme: TapTheme }
  ): Promise<AccountConnection> => {
    if (!held.includes(id)) {
      return Promise.reject(new ApiError("not_found", "No such person", 404));
    }
    const connection = { id, ...profile };
    saved.push(connection);
    return Promise.resolve(connection);
  };
  return { save, saved };
};

/** `/account/send-profile` while this browser is signed out. */
const signedOut = () =>
  Promise.reject(new ApiError("unauthorized", "Sign in", 401));

const ana: Pairing = {
  token: "inboxAna1.keyAna01.secretAna",
  credentialId: "senderAna",
  recipientName: "Ana",
  senderName: "Dr. Sam",
  color: "sky",
};

const ben: Pairing = {
  token: "inboxBen1.keyBen01.secretBen",
  credentialId: "senderBen",
  recipientName: "Ben",
  senderName: "Sam",
  color: "moss",
};

describe("tap style per person", () => {
  it("saves the theme for the chosen person only, keeping how they see you", async () => {
    const storage = memoryStorage({ "shouldertap.style.v1": "note" });
    const account = fakeAccount(["inboxAna1:senderAna", "inboxBen1:senderBen"]);
    const nextAna = await chooseStyle(storage, ana, "terminal", account.save);
    expect(account.saved).toStrictEqual([
      {
        id: "inboxAna1:senderAna",
        name: "Dr. Sam",
        color: "sky",
        theme: "terminal",
      },
    ]);
    expect(styleFor(storage, nextAna)).toBe("terminal");
    // Ben has no theme of their own: Ben keeps following this browser's style.
    expect(styleFor(storage, ben)).toBe("note");
  });

  it("changes this browser's style for a person the account doesn't hold", async () => {
    const storage = memoryStorage({ "shouldertap.style.v1": "note" });
    const nextAna = await chooseStyle(
      storage,
      ana,
      "billboard",
      fakeAccount([]).save
    );
    expect(styleFor(storage, nextAna)).toBe("billboard");
    expect(styleFor(storage, ben)).toBe("billboard");
  });

  it("changes this browser's style when signed out", async () => {
    const storage = memoryStorage({ "shouldertap.style.v1": "note" });
    const nextAna = await chooseStyle(storage, ana, "terminal", signedOut);
    expect(styleFor(storage, nextAna)).toBe("terminal");
    expect(styleFor(storage, ben)).toBe("terminal");
  });

  it("puts the person's own theme ahead of this browser's", () => {
    const storage = memoryStorage({ "shouldertap.style.v1": "note" });
    expect(styleFor(storage, { theme: "broadsheet" })).toBe("broadsheet");
    expect(styleFor(storage, {})).toBe("note");
  });
});
