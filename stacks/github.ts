import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { zoneId } from "../domains.ts";

const repo = { owner: "jakebodea", repository: "shouldertap" } as const;

/**
 * The repo's CI setup as code: mints a Cloudflare API token scoped to what
 * `alchemy.run.ts` deploys, stores it as GitHub Actions secrets, and protects
 * main. Deploy from a laptop to rotate or rescope the token or to change the
 * protection:
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
            // The support@ forwarding destination.
            "Email Routing Addresses Write",
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
            "Email Routing Rules Write",
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

    // Changes reach main only through a pull request whose `check` and `e2e`
    // jobs (in .github/workflows/deploy.yml) passed. Nobody can bypass it, admins
    // included; loosen it here if that ever has to change.
    yield* GitHub.Ruleset("protect-main", {
      ...repo,
      name: "Protect main",
      conditions: { include: ["~DEFAULT_BRANCH"] },
      rules: {
        deletion: true,
        nonFastForward: true,
        pullRequest: { requiredApprovingReviewCount: 0 },
        requiredStatusChecks: {
          // 15368 is the GitHub Actions app.
          checks: [
            { context: "check", integrationId: 15_368 },
            { context: "e2e", integrationId: 15_368 },
          ],
        },
      },
    });
  })
);
