import { describe, expect, it } from "vitest";

import {
  downgradeNote,
  loadDraft,
  loadPatronKey,
  loadStyle,
  saveDraft,
  savePatronKey,
  saveStyle,
  sendRequest,
} from "../apps/web/src/lib/sender-style";

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
    values,
  };
};

describe("sender style on this phone", () => {
  it("keeps a draft per person across leaving for checkout, and clears it once sent", () => {
    const storage = memoryStorage();
    saveDraft(storage, "cred-jake", "Dinner's ready");
    saveDraft(storage, "cred-mia", "Call me");
    // The page reloads after checkout: a fresh read gets each draft back.
    expect([
      loadDraft(storage, "cred-jake"),
      loadDraft(storage, "cred-mia"),
    ]).toStrictEqual(["Dinner's ready", "Call me"]);
    saveDraft(storage, "cred-jake", "");
    expect(loadDraft(storage, "cred-jake")).toBe("");
    expect([...storage.values.keys()]).toStrictEqual([
      "shouldertap.draft.v1.cred-mia",
    ]);
  });

  it("reads an unknown or tampered saved style as Default", () => {
    expect(loadStyle(memoryStorage())).toBe("default");
    expect(
      loadStyle(memoryStorage({ "shouldertap.style.v1": "<style>" }))
    ).toBe("default");
    const storage = memoryStorage();
    saveStyle(storage, "note");
    expect(loadStyle(storage)).toBe("note");
  });

  it("sends the patron key only with a theme that needs it", () => {
    const storage = memoryStorage();
    savePatronKey(storage, "stp1.patronAAAA.keyAAAAAA.secret-AAAAAAAA");
    const key = loadPatronKey(storage);
    expect(sendRequest({ requestId: "r-1", body: "Hi" }, key)).toStrictEqual({
      requestId: "r-1",
      body: "Hi",
    });
    expect(
      sendRequest({ requestId: "r-2", body: "Hi", theme: "default" }, key)
    ).toStrictEqual({ requestId: "r-2", body: "Hi" });
    expect(
      sendRequest({ requestId: "r-3", body: "Hi", theme: "terminal" }, key)
    ).toStrictEqual({
      requestId: "r-3",
      body: "Hi",
      theme: "terminal",
      patronKey: "stp1.patronAAAA.keyAAAAAA.secret-AAAAAAAA",
    });
    // A nonpatron still asks; the server stores Default and delivers it.
    expect(
      sendRequest({ requestId: "r-4", body: "Hi", theme: "terminal" }, null)
    ).toStrictEqual({ requestId: "r-4", body: "Hi", theme: "terminal" });
  });

  it("explains a theme the server stored as Default", () => {
    expect(downgradeNote("broadsheet", { theme: "default" })).toBe(
      "Sent in Default: patron support isn't active on this device."
    );
    expect(downgradeNote("broadsheet", { theme: "broadsheet" })).toBeNull();
    expect(downgradeNote(undefined, {})).toBeNull();
  });
});
