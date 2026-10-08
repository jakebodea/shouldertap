import type { Tap } from "@shouldertap/domain";
import { describe, expect, it } from "vitest";

import { mergeSnapshot, mergeTap } from "./live";

const tap = (id: string, sequence: number, createdAt = sequence): Tap => ({
  id,
  senderId: "s",
  senderName: "Sam",
  senderColor: "moss",
  body: id,
  createdAt,
  state: "pending",
  displayedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  response: null,
  sequence,
});

describe(mergeTap, () => {
  it("inserts newest first", () => {
    expect(mergeTap([tap("a", 1)], tap("b", 2)).map((t) => t.id)).toStrictEqual(
      ["b", "a"]
    );
  });

  it("ignores stale updates", () => {
    const acked = { ...tap("a", 5, 1), state: "acknowledged" as const };
    expect(mergeTap([acked], tap("a", 3, 1))[0]?.state).toBe("acknowledged");
  });
});

describe(mergeSnapshot, () => {
  it("keeps a newer local copy over an older snapshot", () => {
    const local = [{ ...tap("a", 9, 1), state: "acknowledged" as const }];
    const merged = mergeSnapshot(local, [tap("a", 4, 1), tap("b", 5, 2)]);
    expect(merged.map((t) => [t.id, t.state])).toStrictEqual([
      ["b", "pending"],
      ["a", "acknowledged"],
    ]);
  });

  it("drops local taps the server no longer lists", () => {
    expect(
      mergeSnapshot([tap("gone", 1)], [tap("b", 2)]).map((t) => t.id)
    ).toStrictEqual(["b"]);
  });
});
