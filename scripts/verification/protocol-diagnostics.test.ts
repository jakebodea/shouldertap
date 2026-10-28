import { describe, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";

import { protocolDiagnostics } from "./protocol-diagnostics";

describe("public protocol diagnostics", () => {
  it("retains actionable failure locations without publishing auth data", () => {
    const report = {
      numPassedTests: 11,
      numFailedTests: 1,
      numPendingTests: 0,
      numFailedTestSuites: 1,
      testResults: [
        {
          name: "/private/checkout/test/integ.test.ts",
          message: "Authorization: Bearer private-token",
          assertionResults: [
            {
              title: "private-token",
              status: "failed",
              duration: 5002,
              location: { line: 147 },
              failureMessages: [
                "AssertionError: Unauthorized token=private-token otp=123456 " +
                  "at /private/checkout/test/integ.test.ts:177:9",
              ],
            },
          ],
        },
      ],
    } as JsonTestResults;
    expect(protocolDiagnostics(report)).toStrictEqual({
      passed: 11,
      failed: 1,
      pending: 0,
      suitesFailed: 1,
      cases: [
        {
          case: 1,
          status: "failed",
          durationMs: 5002,
          declarationLine: 147,
          failureLocations: [{ line: 177, column: 9 }],
          categories: ["AssertionError", "Unauthorized"],
        },
      ],
    });
  });
});
