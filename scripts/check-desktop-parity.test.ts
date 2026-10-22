import { describe, expect, it } from "vitest";

import { missingLabels } from "./check-desktop-parity.ts";

const mac = `
MenuButton(title: settings ? "Done" : "Settings", kind: .plain) { settings.toggle() }
Text("Can tap you").font(.system(size: 13))
`;

const windows = `
menu_button(s, "settings", if self.settings { "Done" } else { "Settings" }, None, Kind::Plain, false, false)
section(s, "Your devices", devices)
`;

describe("check-desktop-parity", () => {
  it("names the app a label is missing from, and skips labels both carry", () => {
    expect(
      missingLabels(
        ["Settings", "Can tap you", "Your devices", "Done", "Quit"],
        {
          mac,
          windows,
        }
      )
    ).toStrictEqual([
      { label: "Can tap you", missingFrom: "Windows" },
      { label: "Your devices", missingFrom: "Mac" },
      { label: "Quit", missingFrom: "Mac and Windows" },
    ]);
  });

  it("matches whole string literals, not words inside longer text", () => {
    expect(
      missingLabels(["Send"], {
        mac: 'Text("Send code")',
        windows: 'pill("send-code", "Send code", None, None, false)',
      })
    ).toStrictEqual([{ label: "Send", missingFrom: "Mac and Windows" }]);
  });
});
