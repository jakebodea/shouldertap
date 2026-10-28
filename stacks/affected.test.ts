import { describe, expect, it } from "vitest";

import { affectedAreas } from "./affected";

describe(affectedAreas, () => {
  it("skips every scoped gate for a docs-only PR", () => {
    expect(
      affectedAreas("pull_request", ["docs/design.md", "apps/web/README.md"])
    ).toStrictEqual({ native: false, web: false });
  });

  it("runs only native gates for a Mac-only PR", () => {
    expect(
      affectedAreas("pull_request", [
        "apps/macos/Sources/Shouldertap/App.swift",
        "scripts/release-mac.sh",
      ])
    ).toStrictEqual({ native: true, web: false });
  });

  it("runs only web gates for a server change", () => {
    expect(
      affectedAreas("pull_request", ["apps/server/src/index.ts", "bun.lock"])
    ).toStrictEqual({ native: false, web: true });
  });

  it("runs both for a protocol change across server and apps", () => {
    expect(
      affectedAreas("pull_request", [
        "packages/domain/src/protocol.ts",
        "apps/windows/core/src/protocol.rs",
      ])
    ).toStrictEqual({ native: true, web: true });
  });

  it("runs everything when a workflow changes", () => {
    expect(
      affectedAreas("pull_request", [".github/workflows/native.yml"])
    ).toStrictEqual({ native: true, web: true });
  });

  it("runs everything on a push to main", () => {
    expect(affectedAreas("push", ["docs/design.md"])).toStrictEqual({
      native: true,
      web: true,
    });
  });

  it("runs everything when the file list is empty or truncated", () => {
    expect(affectedAreas("pull_request", [])).toStrictEqual({
      native: true,
      web: true,
    });
    expect(
      affectedAreas(
        "pull_request",
        Array.from({ length: 3000 }, (_, i) => `docs/${i}.md`)
      )
    ).toStrictEqual({ native: true, web: true });
  });
});
