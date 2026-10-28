import { describe, expect, it } from "vitest";

import {
  assertDeployment,
  assertVerificationStage,
  stageCreatedAt,
} from "./environment";

describe("verification ownership", () => {
  it("recognizes the creation time used for orphan cleanup", () => {
    expect(stageCreatedAt("verify-loyw3v28-012345abcdef")).toBe(
      1_700_000_000_000
    );
  });

  it.each(["prod", "pr-10", "dev", "verify-foo", "verify-0-012345abcdef"])(
    "refuses cleanup of %s",
    (stage) => {
      expect(() => assertVerificationStage(stage)).toThrow(
        "Refusing non-verification stage"
      );
    }
  );

  it("rejects a healthy backend from another revision", () => {
    expect(() =>
      assertDeployment({ sourceRevision: "old-revision" }, "new-revision")
    ).toThrow("Deployment revision");
  });

  it("rejects a matching commit with a different working-tree deployment", () => {
    expect(() =>
      assertDeployment(
        { sourceRevision: "commit", sourceDigest: "other-tree" },
        "commit",
        "tested-tree"
      )
    ).toThrow("Deployment revision");
  });
});
