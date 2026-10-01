import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { supportEmail, zoneId } from "../../../domains.ts";

/**
 * Inbound mail for the support address, production only. Forwards each
 * message to every address in SUPPORT_FORWARD_TO (comma-separated, each a
 * verified Email Routing destination): the operator's inbox and the Slack
 * channel's email address. Read from the deploy environment so the
 * addresses stay out of this public repo.
 */
export default class Support extends Cloudflare.Worker<Support>()(
  "support",
  {
    main: import.meta.url,
    compatibility: { date: "2026-08-31" },
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const forwardTo = yield* Config.Redacted("SUPPORT_FORWARD_TO");
    const destinations = parseForwardTo(Redacted.value(forwardTo));

    yield* Cloudflare.email({
      zone: zoneId,
      matchers: [{ type: "literal", field: "to", value: supportEmail }],
      ruleName: "support",
    }).subscribe((message) =>
      // A failed forward propagates, so the sending server retries later.
      Effect.forEach(destinations, (to) => message.forward(to), {
        discard: true,
      })
    );

    return {};
  }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive))
) {}

export const parseForwardTo = (value: string) =>
  value
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
