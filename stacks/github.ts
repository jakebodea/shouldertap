import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { zoneId } from "../domains.ts";

const repo = { owner: "jakebodea", repository: "shouldertap" } as const;

/**
 * CI credentials as code: mints a Cloudflare API token scoped to what
 * `alchemy.run.ts` deploys and stores it as GitHub Actions secrets. Deploy
 * once from a laptop, and again only to rotate or rescope the token:
 *
 *   bun alchemy deploy --config stacks/github.ts --profile admin
 */
export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const account = `com.cloudflare.api.account.${accountId}` as const;

    const token = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            // Workers, the Inbox Durable Object, and the rate limiter.
            "Workers Scripts Write",
            "Workers R2 Storage Write",
            "Account Settings Write",
            "Workers Tail Read",
            // Cloudflare.state() reads its bearer token from the Secrets Store.
            "Secrets Store Write",
          ],
          resources: { [account]: "*" },
        },
        {
          // Production only: custom domains, the www redirect, zone settings.
          effect: "allow",
          permissionGroups: [
            "Zone Read",
            "DNS Write",
            "Workers Routes Write",
            "SSL and Certificates Write",
            "Dynamic URL Redirects Write",
            "Zone Settings Write",
          ],
          resources: {
            [account]: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
          },
        },
      ],
    });

    yield* GitHub.Secret("cf-api-token", {
      ...repo,
      name: "CLOUDFLARE_API_TOKEN",
      value: token.value,
    });

    yield* GitHub.Secret("cf-account-id", {
      ...repo,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });
  })
);
