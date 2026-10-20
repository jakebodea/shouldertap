import { describe, expect, it } from "vitest";

import { secretsSource } from "./secrets.ts";

describe(secretsSource, () => {
  it("reads prod from shouldertap-prod", () => {
    expect(secretsSource("prod")).toStrictEqual({
      project: "2ea55940-47f3-4632-ad30-1b8ebdf9daeb",
      environment: "prod",
    });
  });

  it("never gives a PR preview an Infisical project", () => {
    expect(secretsSource("pr-54")).toBeUndefined();
    // Only real preview stages skip Infisical; a look-alike reads dev.
    expect(secretsSource("pr-0")).toStrictEqual({
      project: "fcaaebbd-83e7-4945-911f-cedba3ff25a3",
      environment: "dev",
    });
  });

  it("reads every other stage from shouldertap-dev", () => {
    expect(secretsSource("dev")).toStrictEqual({
      project: "fcaaebbd-83e7-4945-911f-cedba3ff25a3",
      environment: "dev",
    });
    expect(secretsSource("jake")).toStrictEqual({
      project: "fcaaebbd-83e7-4945-911f-cedba3ff25a3",
      environment: "dev",
    });
  });
});
