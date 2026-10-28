import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateRuntimeFiles, validateRuntimeProof } from "./runtime-proof";

const example = () => ({
  head: "commit",
  baseSha: "base",
  sourceDigest:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  verdict: "PASS",
  cleaned: true,
  scenario: "core",
  results: [
    { name: "protocol", exitCode: 0 },
    { name: "preview-smoke", exitCode: 0 },
    { name: "native-core", exitCode: 0 },
  ],
  artifacts: [{ path: "native-receive.png", sha256: "abc" }],
});

describe("runtime source provenance", () => {
  it("accepts executed native evidence for exactly the clean source", () => {
    expect(validateRuntimeProof(example(), "commit", "base").scenario).toBe(
      "core"
    );
  });

  it("rejects a successful run against uncommitted edits", () => {
    expect(() =>
      validateRuntimeProof(
        { ...example(), sourceDigest: "dirty" },
        "commit",
        "base"
      )
    ).toThrow("clean committed source");
  });

  it("rejects omitted native execution despite a passing label", () => {
    expect(() =>
      validateRuntimeProof(
        { ...example(), results: [{ name: "protocol", exitCode: 0 }] },
        "commit",
        "base"
      )
    ).toThrow("required execution");
  });

  it("rejects evidence from the preceding source revision", () => {
    expect(() => validateRuntimeProof(example(), "new-commit", "base")).toThrow(
      "clean committed source"
    );
  });

  it("checks captured artifact bytes before importing proof", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "shouldertap-proof-"));
    const filename = path.join(directory, "receipt.json");
    try {
      writeFileSync(path.join(directory, "native-receive.png"), "hello");
      writeFileSync(
        filename,
        JSON.stringify({
          ...example(),
          artifacts: [
            {
              path: "native-receive.png",
              sha256:
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            },
          ],
        })
      );
      expect(validateRuntimeFiles(filename, "commit", "base").scenario).toBe(
        "core"
      );
      writeFileSync(
        path.join(directory, "native-receive.png"),
        "changed image"
      );
      expect(() => validateRuntimeFiles(filename, "commit", "base")).toThrow(
        "Runtime artifact changed"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
