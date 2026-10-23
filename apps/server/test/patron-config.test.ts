import { unpackEnvValue } from "alchemy/RuntimeContext";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  checkoutFlagValue,
  patronCheckoutConfig,
} from "../src/account-billing";

describe("patron checkout configuration", () => {
  it.each([
    [true, true],
    [false, false],
  ] as const)(
    "preserves the enabled=%s flag through Alchemy runtime decoding",
    async (enabled, expected) => {
      const raw = checkoutFlagValue(enabled);
      // Match Platform's interceptor: fromUnknown would stringify booleans.
      const provider = ConfigProvider.make(() =>
        Effect.succeed(
          ConfigProvider.makeValue(unpackEnvValue<string>(raw) ?? "missing")
        )
      );
      const result = await Effect.runPromise(
        patronCheckoutConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider)
        )
      );
      expect(result).toBe(expected);
    }
  );

  it("keeps checkout disabled when no flag is bound", async () => {
    const result = await Effect.runPromise(
      patronCheckoutConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({})
        )
      )
    );
    expect(result).toBe(false);
  });
});
