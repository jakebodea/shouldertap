import { describe, expect, it } from "vitest";

import { secretsSource } from "./secrets.ts";

const prod = {
  project: "2ea55940-47f3-4632-ad30-1b8ebdf9daeb",
  environment: "prod",
};
const dev = {
  project: "fcaaebbd-83e7-4945-911f-cedba3ff25a3",
  environment: "dev",
};

describe(secretsSource, () => {
  it("reads prod from shouldertap-prod, locally and in CI", () => {
    expect(secretsSource("prod", false)).toStrictEqual(prod);
    expect(secretsSource("prod", true)).toStrictEqual(prod);
  });

  it("never gives a PR preview an Infisical project", () => {
    expect(secretsSource("pr-54", false)).toBeUndefined();
    expect(secretsSource("pr-54", true)).toBeUndefined();
    // Only real preview stages skip Infisical; a look-alike reads dev.
    expect(secretsSource("pr-0", false)).toStrictEqual(dev);
  });

  it("keeps verification stages credential-free while ordinary development still uses dev", () => {
    expect(secretsSource("dev", false)).toStrictEqual(dev);
    expect(
      secretsSource("verify-loyw3v28-012345abcdef", false)
    ).toBeUndefined();
    expect(secretsSource("verify-loyw3v28-012345abcdef", true)).toBeUndefined();
    expect(() => secretsSource("verify-../prod", false)).toThrow(
      "Invalid verification stage"
    );
  });

  it("gives other CI stages nothing, and local stages shouldertap-dev", () => {
    expect(secretsSource("dev", true)).toBeUndefined();
    expect(secretsSource("dev", false)).toStrictEqual(dev);
    expect(secretsSource("jake", false)).toStrictEqual(dev);
  });
});
