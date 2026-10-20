import { describe, expect, it } from "vitest";

import { productionEnvironment } from "./github.ts";

describe(productionEnvironment, () => {
  it("lets only main deploy to production", () => {
    expect(
      productionEnvironment({ owner: "jbolabs", repository: "shouldertap" })
    ).toStrictEqual({
      owner: "jbolabs",
      repository: "shouldertap",
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    });
  });
});
