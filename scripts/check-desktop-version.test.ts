import { describe, expect, it } from "vitest";

import {
  desktopVersionError,
  parseCargoVersion,
  parsePlistVersion,
} from "./check-desktop-version.ts";

describe("check-desktop-version", () => {
  it("reads the Mac marketing version from Info.plist", () => {
    expect(
      parsePlistVersion(`<dict>
  <key>CFBundleShortVersionString</key>
  <string>0.8.0</string>
  <key>CFBundleVersion</key>
  <string>13</string>
</dict>`)
    ).toBe("0.8.0");
  });

  it("reads the workspace version, not a dependency's", () => {
    expect(
      parseCargoVersion(`[workspace]
members = ["core", "app"]

[workspace.package]
version = "0.8.0"
edition = "2024"

[workspace.dependencies]
serde = { version = "1" }`)
    ).toBe("0.8.0");
  });

  it("flags a Mac and Windows version that drifted apart", () => {
    expect(desktopVersionError("0.8.0", "1.1.0")).toBe(
      "Mac is 0.8.0 but Windows is 1.1.0: bump apps/macos/Resources/Info.plist and apps/windows/Cargo.toml together"
    );
  });
});
