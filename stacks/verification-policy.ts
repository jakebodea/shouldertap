/**
 * One decision boundary for required CI: skipped and cancelled checks fail
 * closed. A pull request may skip gates its changed files cannot affect
 * (stacks/affected.ts); a push to main, which deploys prod and feeds Release,
 * requires every gate whatever the scoping says.
 */
export const requireVerification = (input: {
  event: string;
  repository: string;
  headRepository?: string;
  changes?: string;
  nativeAffected?: string;
  webAffected?: string;
  check?: string;
  e2e?: string;
  native?: string;
  browser?: string;
  preview?: string;
  previewVerified?: string;
}) => {
  if (
    input.event === "pull_request" &&
    input.headRepository !== input.repository
  ) {
    throw new Error(
      "Forks cannot receive test credentials. Verify reviewed changes on a trusted repository branch before merge."
    );
  }
  if (input.changes !== "success") {
    throw new Error(
      `Changed-file scoping did not complete: ${input.changes ?? "missing"}.`
    );
  }
  // Only a PR may scope, and only an explicit "false" skips a gate.
  const scoped = input.event === "pull_request";
  const native = !scoped || input.nativeAffected !== "false";
  const web = !scoped || input.webAffected !== "false";
  const required = { check: true, e2e: web, native, browser: web } as const;
  for (const check of ["check", "e2e", "native", "browser"] as const) {
    const result = input[check];
    const passed =
      result === "success" || (!required[check] && result === "skipped");
    if (!passed) {
      throw new Error(
        `Required ${check} verification did not pass: ${result ?? "missing"}.`
      );
    }
  }
  if (
    input.event === "pull_request" &&
    web &&
    (input.preview !== "success" || input.previewVerified !== "true")
  ) {
    throw new Error(
      "Required preview integration did not execute successfully."
    );
  }
  if (input.event !== "push" && input.event !== "pull_request") {
    throw new Error("Unsupported verification event.");
  }
  return {
    verdict: "PASS",
    native: native ? "compiled-and-core-tested" : "not-affected",
    browser: web ? "hosted-ui-and-protocol" : "not-affected",
  } as const;
};

if (import.meta.main) {
  try {
    process.stdout.write(
      `${JSON.stringify(
        requireVerification({
          event: process.env.EVENT ?? "",
          repository: process.env.REPO ?? "",
          headRepository: process.env.HEAD_REPO,
          changes: process.env.CHANGES,
          nativeAffected: process.env.NATIVE_AFFECTED,
          webAffected: process.env.WEB_AFFECTED,
          check: process.env.CHECK,
          e2e: process.env.E2E,
          native: process.env.NATIVE,
          browser: process.env.BROWSER,
          preview: process.env.PREVIEW,
          previewVerified: process.env.PREVIEW_VERIFIED,
        })
      )}\n`
    );
  } catch (error) {
    process.stderr.write(
      `::error::${error instanceof Error ? error.message : "Verification failed"}\n`
    );
    process.exitCode = 1;
  }
}
