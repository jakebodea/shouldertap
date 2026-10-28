import { describe, expect, it } from "vitest";

import {
  artifactKindForPath,
  classifyChangedFiles,
  deriveVerdict,
  githubAttachmentArgument,
  maxRiskTier,
  renderProofReport,
  requiresVisualEvidence,
  validateReceiptSemantics,
} from "./proof-core";
import type { ProofReceipt } from "./proof-core";

type Gate = ProofReceipt["commands"][number];
const passingRuntimeGates: [Gate, Gate, Gate] = [
  {
    command: "bun run ci",
    durationMs: 42,
    exitCode: 0,
    logPath: "logs/ci.log",
    name: "ci",
    sha256: "a".repeat(64),
    status: "pass",
  },
  {
    command: "bun run build",
    durationMs: 42,
    exitCode: 0,
    logPath: "logs/build.log",
    name: "build",
    sha256: "b".repeat(64),
    status: "pass",
  },
  {
    command: "bun run verify -- --local --scenario core",
    durationMs: 42,
    exitCode: 0,
    logPath: "logs/runtime.log",
    name: "runtime",
    sha256: "c".repeat(64),
    status: "pass",
  },
];

const validHighReceipt = (): ProofReceipt => ({
  artifacts: [],
  base: { ref: "origin/main", sha: "base" },
  changedFiles: ["apps/server/src/Inbox.ts"],
  commands: passingRuntimeGates.map((command) => ({ ...command })),
  createdAt: "2026-10-27T20:00:00.000Z",
  flows: ["Sign in, send a tap, receive and answer through the native UI"],
  focusedChecks: [],
  headSha: "head",
  independentVerification: {
    source: "task:verifier",
    summary: "Messaging flow independently verified",
    verdict: "PASS",
  },
  notes: [],
  patchId: "patch",
  requiresVisualEvidence: false,
  riskTier: "high",
  rollback: null,
  runtimeBundle: { path: "runtime/receipt.json", sha256: "a".repeat(64) },
  schemaVersion: 1,
  verdict: "PASS",
});

describe("proof classification", () => {
  it("uses the highest risk path in a change", () => {
    expect(
      classifyChangedFiles([
        "docs/ci-cd.md",
        "apps/web/src/components/button.tsx",
        "apps/server/src/account-auth.ts",
      ])
    ).toBe("critical");
  });

  it("requires visual proof only for changed visible surfaces", () => {
    expect(
      requiresVisualEvidence(["apps/web/src/components/button.tsx"])
    ).toBeTruthy();
    expect(
      requiresVisualEvidence(["apps/web/src/components/button.test.tsx"])
    ).toBeFalsy();
    expect(
      requiresVisualEvidence(["apps/server/src/account-auth.ts"])
    ).toBeFalsy();
    expect(
      requiresVisualEvidence(["apps/web/public/product-preview.png"])
    ).toBeTruthy();
    expect(requiresVisualEvidence(["apps/web/src/styles.css"])).toBeTruthy();
  });

  it("allows explicit risk only to raise automatic classification", () => {
    expect(maxRiskTier("high", "low")).toBe("high");
    expect(maxRiskTier("medium", "critical")).toBe("critical");
  });

  it("accepts only GitHub-renderable media", () => {
    expect(artifactKindForPath("proof.png")).toBe("image");
    expect(artifactKindForPath("walkthrough.mp4")).toBe("video");
    expect(() => artifactKindForPath("report.txt")).toThrow(
      "must be an image or video"
    );
  });

  it("adds alt text to image uploads but not video uploads", () => {
    expect(
      githubAttachmentArgument("/tmp/proof.png", {
        alt: "Proof state",
        kind: "image",
      })
    ).toBe("/tmp/proof.png#Proof state");
    expect(
      githubAttachmentArgument("/tmp/proof.mp4", {
        alt: "Walkthrough",
        kind: "video",
      })
    ).toBe("/tmp/proof.mp4");
  });
});

describe("proof report", () => {
  it("binds the report to revision identity and recorded checks", () => {
    const receipt: ProofReceipt = {
      artifacts: [],
      base: { ref: "origin/main", sha: "base" },
      changedFiles: ["docs/ci-cd.md"],
      commands: [
        {
          command: "bun run ci",
          durationMs: 42,
          exitCode: 0,
          logPath: "logs/ci.log",
          name: "ci",
          sha256: "a".repeat(64),
          status: "pass",
        },
      ],
      createdAt: "2026-09-21T20:00:00.000Z",
      flows: [],
      focusedChecks: [],
      headSha: "head",
      independentVerification: null,
      notes: [],
      patchId: "patch",
      requiresVisualEvidence: false,
      riskTier: "low",
      rollback: null,
      runtimeBundle: null,
      schemaVersion: 1,
      verdict: "PASS",
    };

    const report = renderProofReport(receipt);
    expect(report).toContain("proofed-delivery:head");
    expect(report).toContain("stable patch `patch`");
    expect(report).toContain("| ci | pass | `bun run ci` | 42 ms |");
  });

  it("rejects contradictory or downgraded receipt claims", () => {
    const receipt: ProofReceipt = {
      artifacts: [],
      base: { ref: "origin/main", sha: "base" },
      changedFiles: ["docs/ci-cd.md"],
      commands: [
        {
          command: "true",
          durationMs: 42,
          exitCode: 1,
          logPath: "logs/ci.log",
          name: "ci",
          sha256: "a".repeat(64),
          status: "pass",
        },
      ],
      createdAt: "2026-09-21T20:00:00.000Z",
      flows: [],
      focusedChecks: [],
      headSha: "head",
      independentVerification: null,
      notes: [],
      patchId: "patch",
      requiresVisualEvidence: false,
      riskTier: "low",
      rollback: null,
      runtimeBundle: null,
      schemaVersion: 1,
      verdict: "PASS",
    };

    expect(
      validateReceiptSemantics(receipt, {
        changedFiles: ["apps/server/src/account-auth.ts"],
        minimumRiskTier: "critical",
        requiresVisualEvidence: false,
      })
    ).toStrictEqual(
      expect.arrayContaining([
        "changed files do not match the proved revision",
        "risk tier is lower than the changed paths require",
        "ci command is not the canonical gate",
        "ci status contradicts its exit code",
      ])
    );
  });

  it("blocks high-risk proof without an independent verifier", () => {
    expect(
      deriveVerdict({
        artifacts: [],
        commands: passingRuntimeGates,
        focusedChecks: [],
        independentVerification: null,
        notes: [],
        requiresVisualEvidence: false,
        riskTier: "high",
        rollback: null,
        runtimeBundle: null,
      })
    ).toBe("BLOCKED");
  });

  it("blocks critical proof without a captured focused boundary check", () => {
    const criticalProof: Parameters<typeof deriveVerdict>[0] = {
      artifacts: [],
      commands: passingRuntimeGates,
      focusedChecks: [],
      independentVerification: {
        source: "task:verifier",
        summary: "Auth boundary reviewed",
        verdict: "PASS",
      },
      notes: [],
      requiresVisualEvidence: false,
      riskTier: "critical",
      rollback: "Revert the commit",
      runtimeBundle: { path: "runtime/receipt.json", sha256: "a".repeat(64) },
    };

    expect(deriveVerdict(criticalProof)).toBe("BLOCKED");
    expect(
      deriveVerdict({
        ...criticalProof,
        focusedChecks: [
          {
            command: "bun vitest run auth.test.ts",
            durationMs: 10,
            exitCode: 0,
            logPath: "logs/focused-1.log",
            name: "Auth boundary",
            sha256: "b".repeat(64),
            status: "pass",
          },
        ],
      })
    ).toBe("PASS");
  });
});

describe("runtime proof gate", () => {
  const facts = {
    changedFiles: ["apps/server/src/Inbox.ts"],
    minimumRiskTier: "high" as const,
    requiresVisualEvidence: false,
  };

  it("allows a complete runtime receipt and blocks missing native execution", () => {
    expect(deriveVerdict(validHighReceipt())).toBe("PASS");
    const receipt = {
      ...validHighReceipt(),
      commands: passingRuntimeGates.slice(0, 2),
    };
    expect(deriveVerdict(receipt)).toBe("BLOCKED");
    expect(validateReceiptSemantics(receipt, facts)).toContain(
      "recorded gates do not match the risk tier and CI result"
    );
  });

  it("rejects replacing the runtime scenario with a successful no-op", () => {
    const receipt = validHighReceipt();
    receipt.commands[2] = { ...passingRuntimeGates[2], command: "true" };
    expect(deriveVerdict(receipt)).toBe("FAIL");
    expect(validateReceiptSemantics(receipt, facts)).toContain(
      "runtime command is not the canonical gate"
    );
  });

  it("rejects a passing claim when runtime execution exited nonzero", () => {
    const receipt = validHighReceipt();
    receipt.commands[2] = { ...passingRuntimeGates[2], exitCode: 1 };
    expect(deriveVerdict(receipt)).toBe("FAIL");
    expect(validateReceiptSemantics(receipt, facts)).toContain(
      "runtime status contradicts its exit code"
    );
  });

  it("records a failed build without requiring an unexecuted runtime gate", () => {
    const receipt: ProofReceipt = {
      ...validHighReceipt(),
      commands: [
        passingRuntimeGates[0],
        {
          ...passingRuntimeGates[1],
          exitCode: 1,
          status: "fail",
        },
      ],
      verdict: "FAIL",
    };
    expect(deriveVerdict(receipt)).toBe("FAIL");
    expect(validateReceiptSemantics(receipt, facts)).toStrictEqual([]);
  });
});
