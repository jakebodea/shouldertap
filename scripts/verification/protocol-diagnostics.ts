import type { JsonTestResults } from "vitest/node";

const errorCategories = [
  "AssertionError",
  "TimeoutException",
  "TimeoutError",
  "RateLimited",
  "Unauthorized",
  "InvalidRequest",
  "RequestError",
  "ResponseError",
  "SocketError",
] as const;
const sourceLocation = /integ\.test\.ts:(?<line>\d+):(?<column>\d+)/gu;

/** Publish only numeric source locations and fixed categories, never error bodies. */
export const protocolDiagnostics = (report: JsonTestResults) => ({
  passed: report.numPassedTests,
  failed: report.numFailedTests,
  pending: report.numPendingTests,
  suitesFailed: report.numFailedTestSuites,
  cases: report.testResults.flatMap((suite) =>
    suite.assertionResults.map((test, index) => {
      const failures = (test.failureMessages ?? []).join("\n");
      return {
        case: index + 1,
        status: ["passed", "failed", "pending", "skipped", "todo"].includes(
          test.status
        )
          ? test.status
          : "unknown",
        durationMs: test.duration ?? null,
        declarationLine: test.location?.line ?? null,
        failureLocations: [...failures.matchAll(sourceLocation)].map(
          (match) => ({
            line: Number(match.groups?.line),
            column: Number(match.groups?.column),
          })
        ),
        categories: errorCategories.filter((category) =>
          failures.includes(category)
        ),
      };
    })
  ),
});
