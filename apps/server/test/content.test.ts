import { describe, expect, test } from "bun:test";

import { isObjectionable } from "../src/content";

describe("private message safety baseline", () => {
  test.each([
    "I will kill you",
    "ＫＩＬＬ ＹＯＵ",
    "k\u200Bill yourself",
    "child pornography",
  ])("rejects direct threats and explicit abuse: %s", (text) => {
    expect(isObjectionable(text)).toBe(true);
  });
  test.each([
    "Dinner's ready",
    "Call me when you're free",
    "I killed the process",
    "Can you get the door?",
  ])("keeps ordinary messages: %s", (text) => {
    expect(isObjectionable(text)).toBe(false);
  });
});
