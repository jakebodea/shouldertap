import { describe, expect, it } from "vitest";

import { requireVerification } from "./verification-policy";

const passing = {
  event: "pull_request",
  repository: "jbolabs/shouldertap",
  headRepository: "jbolabs/shouldertap",
  check: "success",
  e2e: "success",
  native: "success",
  browser: "success",
  preview: "success",
  previewVerified: "true",
};

describe(requireVerification, () => {
  it("accepts completed browser, protocol, native and preview gates", () => {
    expect(requireVerification(passing)).toStrictEqual({
      verdict: "PASS",
      native: "compiled-and-core-tested",
      browser: "hosted-ui-and-protocol",
    });
  });

  it.each(["failure", "cancelled", "skipped", undefined])(
    "rejects a required native result of %s",
    (native) => {
      expect(() => requireVerification({ ...passing, native })).toThrow(
        "Required native verification did not pass"
      );
    }
  );

  it("rejects a preview job which succeeded by skipping deployment", () => {
    expect(() =>
      requireVerification({ ...passing, previewVerified: "false" })
    ).toThrow("Required preview integration did not execute");
  });

  it("rejects fork verification even when every supplied result says success", () => {
    expect(() =>
      requireVerification({
        ...passing,
        headRepository: "contributor/shouldertap",
      })
    ).toThrow("Forks cannot receive test credentials");
  });

  it("does not require a PR preview when verifying main", () => {
    expect(
      requireVerification({
        ...passing,
        event: "push",
        preview: "skipped",
        previewVerified: "false",
      })
    ).toStrictEqual({
      verdict: "PASS",
      native: "compiled-and-core-tested",
      browser: "hosted-ui-and-protocol",
    });
  });
});
