import { describe, expect, it } from "vitest";

import {
  findStaleOwnerReferences,
  readWorkflows,
} from "./check-workflow-owner.ts";

describe("check-workflow-owner", () => {
  it("flags the old GitHub owner with the fix", () => {
    const errors = findStaleOwnerReferences([
      {
        path: "deploy.yml",
        text: "with:\n  oidc-audience: https://github.com/jakebodea\n",
      },
    ]);
    expect(errors).toStrictEqual([
      "deploy.yml:2: repo moved to jbolabs; use https://github.com/jbolabs / jbolabs/shouldertap",
    ]);
  });

  it("finds no old owner in the checked-in workflows", () => {
    const workflows = readWorkflows();
    expect(workflows.map((w) => w.path)).toContain(
      ".github/workflows/deploy.yml"
    );
    expect(findStaleOwnerReferences(workflows)).toStrictEqual([]);
  });
});
