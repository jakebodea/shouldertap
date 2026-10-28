import { describe, expect, it } from "vitest";

import { requireVerification } from "./verification-policy";

const passing = {
  event: "pull_request",
  repository: "jbolabs/shouldertap",
  headRepository: "jbolabs/shouldertap",
  changes: "success",
  nativeAffected: "true",
  webAffected: "true",
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

  it("lets a web-only PR skip native gates", () => {
    expect(
      requireVerification({
        ...passing,
        nativeAffected: "false",
        native: "skipped",
      })
    ).toStrictEqual({
      verdict: "PASS",
      native: "not-affected",
      browser: "hosted-ui-and-protocol",
    });
  });

  it("lets a native-only PR skip browser, e2e and preview gates", () => {
    expect(
      requireVerification({
        ...passing,
        webAffected: "false",
        e2e: "skipped",
        browser: "skipped",
        preview: "skipped",
        previewVerified: "",
      })
    ).toStrictEqual({
      verdict: "PASS",
      native: "compiled-and-core-tested",
      browser: "not-affected",
    });
  });

  it("still fails an unaffected gate that ran and failed", () => {
    expect(() =>
      requireVerification({
        ...passing,
        nativeAffected: "false",
        native: "failure",
      })
    ).toThrow("Required native verification did not pass: failure.");
  });

  it("requires every gate on main even if scoping says unaffected", () => {
    expect(() =>
      requireVerification({
        ...passing,
        event: "push",
        nativeAffected: "false",
        webAffected: "false",
        native: "skipped",
      })
    ).toThrow("Required native verification did not pass: skipped.");
  });

  it("treats a missing scoping flag as affected", () => {
    expect(() =>
      requireVerification({
        ...passing,
        webAffected: undefined,
        browser: "skipped",
      })
    ).toThrow("Required browser verification did not pass: skipped.");
  });

  it.each(["failure", "cancelled", "skipped", undefined])(
    "rejects a changed-file scoping result of %s",
    (changes) => {
      expect(() => requireVerification({ ...passing, changes })).toThrow(
        "Changed-file scoping did not complete"
      );
    }
  );
});
