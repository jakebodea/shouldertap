import { describe, expect, it } from "vitest";

import { isObjectionable } from "../src/content";

describe("private message safety baseline", () => {
  it.each([
    "I will kill you",
    "ＫＩＬＬ ＹＯＵ",
    "k\u200Bill yourself",
    "child pornography",
  ])("rejects direct threats and explicit abuse: %s", (text) => {
    expect(isObjectionable(text)).toBeTruthy();
  });

  it.each([
    "Dinner's ready",
    "Call me when you're free",
    "I killed the process",
    "Can you get the door?",
  ])("keeps ordinary messages: %s", (text) => {
    expect(isObjectionable(text)).toBeFalsy();
  });
});
