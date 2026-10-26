import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { SendTapRequest } from "./contracts";
import {
  describeResponse,
  normalizeQuickReplies,
  quickRepliesFor,
} from "./responses";

describe("quick replies", () => {
  it("offers On it and In 10 min on a tap that doesn't carry its own", () => {
    expect(quickRepliesFor({})).toStrictEqual([
      { label: "On it", response: { kind: "on_it" } },
      { label: "In 10 min", response: { kind: "in_10" } },
    ]);
  });

  it("answers a sender's own option as text, so any client shows its label", () => {
    const [first, second] = quickRepliesFor({
      replies: ["Coming!", "Can't now"],
    });
    expect(first).toStrictEqual({
      label: "Coming!",
      response: { kind: "text", text: "Coming!" },
    });
    expect(second && describeResponse(second.response)).toBe("Can't now");
  });

  it("tidies what a sender typed, dropping the defaults", () => {
    expect(normalizeQuickReplies([" Coming! ", "Can't now"])).toStrictEqual({
      replies: ["Coming!", "Can't now"],
    });
    expect(normalizeQuickReplies(["On it", "In 10 min"])).toStrictEqual({
      replies: null,
    });
    expect(normalizeQuickReplies(["Yes", "  "])).toStrictEqual({
      error: "Write both reply options",
    });
    expect(normalizeQuickReplies(["Yes", "yes"])).toStrictEqual({
      error: "Make the two reply options different",
    });
    expect(
      normalizeQuickReplies(["Yes", "Give me twenty-five minutes"])
    ).toStrictEqual({
      error: "Keep each reply option to 24 characters",
    });
  });

  it("accepts exactly two short, trimmed options on a send", () => {
    const decode = Schema.decodeUnknownExit(SendTapRequest);
    const base = { requestId: "req-12345", body: "Hi" };
    expect(decode({ ...base, replies: ["Yes", "No"] })._tag).toBe("Success");
    expect(decode({ ...base, replies: ["Yes"] })._tag).toBe("Failure");
    expect(decode({ ...base, replies: ["Yes", "No", "Maybe"] })._tag).toBe(
      "Failure"
    );
    expect(decode({ ...base, replies: ["Yes", " No"] })._tag).toBe("Failure");
    expect(decode({ ...base, replies: ["Yes", "x".repeat(25)] })._tag).toBe(
      "Failure"
    );
  });
});
