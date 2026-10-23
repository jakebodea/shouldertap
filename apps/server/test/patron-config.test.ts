import { unpackEnvValue } from "alchemy/RuntimeContext";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { patronCheckoutConfig } from "../src/account-billing";

describe("patron checkout configuration", () => {
  it.each([
    ["true", true],
    ["false", false],
    ['"true"', true],
    ['"false"', false],
    ["yes", true],
    ["no", false],
    [undefined, false],
  ] as const)(
    "reads the Alchemy runtime value for %s",
    async (raw, expected) => {
      const provider = ConfigProvider.fromUnknown({
        PATRON_CHECKOUT_ENABLED: unpackEnvValue(raw),
      });
      const enabled = await Effect.runPromise(
        patronCheckoutConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider)
        )
      );
      expect(enabled).toBe(expected);
    }
  );
});
