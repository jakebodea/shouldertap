import { describe, expect, it } from "vitest";

import { findImplicitGatesBehindAggregates } from "./check-workflow-gates.ts";
import { readWorkflows } from "./check-workflow-owner.ts";

// deploy.yml as of #120: prod deploy was skipped on every push to main.
const skippedProd = `
jobs:
  check: {}
  preview:
    needs: check
    if: github.event_name == 'pull_request'
  verification:
    if: always()
    needs: [check, preview]
  deploy:
    needs: verification
    if: github.event_name == 'push'
`;

describe(findImplicitGatesBehindAggregates, () => {
  it("flags a job whose implicit success() reaches past an always() aggregate", () => {
    expect(
      findImplicitGatesBehindAggregates("deploy.yml", skippedProd)
    ).toStrictEqual([
      `deploy.yml: job "deploy" has an implicit success() over everything verification tolerates; gate on \${{ !cancelled() && needs.verification.result == 'success' }}`,
    ]);
  });

  it("accepts a job gated on the aggregate's own result", () => {
    const fixed = skippedProd.replace(
      "if: github.event_name == 'push'",
      `if: \${{ !cancelled() && github.event_name == 'push' && needs.verification.result == 'success' }}`
    );
    expect(
      findImplicitGatesBehindAggregates("deploy.yml", fixed)
    ).toStrictEqual([]);
    // Guards against the replace above silently not matching.
    expect(fixed).toContain("needs.verification.result");
  });

  it("finds no unreachable gates in the checked-in workflows", () => {
    const workflows = readWorkflows();
    expect(workflows.map((w) => w.path)).toContain(
      ".github/workflows/deploy.yml"
    );
    expect(
      workflows.flatMap((w) =>
        findImplicitGatesBehindAggregates(w.path, w.text)
      )
    ).toStrictEqual([]);
  });
});
