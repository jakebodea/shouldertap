/** One decision boundary for required CI: skipped and cancelled checks fail closed. */
export const requireVerification = (input: {
  event: string;
  repository: string;
  headRepository?: string;
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
  for (const check of ["check", "e2e", "native", "browser"] as const) {
    if (input[check] !== "success") {
      throw new Error(
        `Required ${check} verification did not pass: ${input[check] ?? "missing"}.`
      );
    }
  }
  if (
    input.event === "pull_request" &&
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
    native: "compiled-and-core-tested",
    browser: "hosted-ui-and-protocol",
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
