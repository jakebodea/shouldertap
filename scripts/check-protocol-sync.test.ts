import { describe, expect, it } from "vitest";

import {
  collectProtocolSyncErrors,
  parseRustSwatches,
  parseTsSwatches,
} from "./check-protocol-sync.ts";

describe("check-protocol-sync", () => {
  it("reports no drift on the checked-in mirrors", () => {
    expect(collectProtocolSyncErrors()).toStrictEqual([]);
  });

  it("flags when Rust swatches drift from TypeScript", () => {
    const ts = parseTsSwatches(`export const swatches = {
  moss: { label: "Moss", base: "#1f5a3d", ink: "#f4f1e8" },
};`);
    const rust = parseRustSwatches(
      `Self::Moss => ("Moss", 0x1f5a3d, 0x000000)`
    );
    expect(ts.get("moss")?.ink).toBe("#f4f1e8");
    expect(rust.get("moss")?.ink).toBe("#000000");
  });
});
