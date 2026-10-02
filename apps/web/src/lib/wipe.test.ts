import { describe, expect, test } from "bun:test";

import { wipeEdgeCoverage } from "./wipe";

describe("wipeEdgeCoverage", () => {
  test("the top changes before the circle reaches the bottom", () => {
    expect(wipeEdgeCoverage(200, 400, 0)).toBe(0.5);
    expect(wipeEdgeCoverage(200, 400, 800)).toBe(0);
    expect(wipeEdgeCoverage(800, 400, 800)).toBe(0);
  });

  test("edge coverage follows the intersection of the circle with that edge", () => {
    // A 3-4-5 triangle: radius 5 reaches four units across an edge at y=3.
    expect(wipeEdgeCoverage(5, 8, 3)).toBe(0.5);
    expect(wipeEdgeCoverage(5, 4, 3)).toBe(1);
    expect(wipeEdgeCoverage(50, 80, 30)).toBe(0.5);
    expect(wipeEdgeCoverage(0, 0, 0)).toBe(0);
  });
});
