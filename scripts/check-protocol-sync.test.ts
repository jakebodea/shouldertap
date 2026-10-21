import { describe, expect, it } from "vitest";

import {
  collectProtocolSyncErrors,
  parseEnumCases,
  parseRustSwatches,
  parseRustThemes,
  parseSwiftThemes,
  parseTsSenderThemes,
  parseTsSwatches,
  parseTsThemes,
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

  it("reads each mirror's theme list so a missing renderer is caught", () => {
    expect(
      parseTsThemes(
        `export const TAP_THEMES = [\n  "default",\n  "note",\n] as const;`
      )
    ).toStrictEqual(["default", "note"]);
    expect(
      parseSwiftThemes(
        "public enum TapTheme: String, CaseIterable {\n  case `default`, note\n"
      )
    ).toStrictEqual(["default", "note"]);
    expect(
      parseRustThemes(
        "impl TapTheme {\n    pub const ALL: [TapTheme; 1] = [Self::Default];"
      )
    ).toStrictEqual(["default"]);
  });

  it("reads the recipient's plain override from each mirror", () => {
    expect(
      parseTsSenderThemes(
        `export const SENDER_THEME_PREFERENCES = ["show", "plain"] as const;`
      )
    ).toStrictEqual(["show", "plain"]);
    expect(
      parseEnumCases(
        "public enum SenderThemePreference: String {\n  /// Doc.\n  case show\n  case plain\n\n  public init() {}\n}",
        "SenderThemePreference"
      )
    ).toStrictEqual(["show", "plain"]);
    expect(
      parseEnumCases(
        "pub enum SenderThemePreference {\n    #[default]\n    Show,\n    Plain,\n}",
        "SenderThemePreference"
      )
    ).toStrictEqual(["show", "plain"]);
  });
});
