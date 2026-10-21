import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { zoneId } from "../domains.ts";

const repo = { owner: "jbolabs", repository: "shouldertap" } as const;

/**
 * The only GitHub environment that can read prod secrets. Infisical's
 * `ci-prod` identity trusts only OIDC tokens from jobs in it, and only main
 * may deploy to it, so PR jobs can never reach shouldertap-prod.
 */
export const productionEnvironment = (target: typeof repo) => ({
  ...target,
  name: "production",
  deploymentBranchPolicy: { customBranchPolicies: ["main"] },
});

/** How jobs in `production` log in to Infisical, as environment variables. */
export const productionVariables = {
  // ci-prod, Viewer on every *-prod Infisical project.
  INFISICAL_IDENTITY_ID: "23fa16cc-a7a1-4e35-8011-2f24b0e037ba",
  INFISICAL_OIDC_AUDIENCE: "https://github.com/jbolabs",
} as const;

/** Labels that release an app when the pull request merges (.github/workflows/release.yml). */
export const releaseLabels = {
  "release:ios": "Upload the iOS app to TestFlight when this merges",
  "release:beta":
    "Upload the iOS app to TestFlight when this merges (same as release:ios)",
  "release:mac": "Publish the Mac app when this merges",
  "release:windows": "Publish the Windows app when this merges",
  "release:desktop": "Publish the Mac and Windows apps when this merges",
} as const;

/**
 * The repo's CI setup as code: mints a Cloudflare API token scoped to what
 * `alchemy.run.ts` deploys, stores it as GitHub Actions secrets, creates the
 * main-only `production` environment that prod jobs read Infisical through,
 * creates the release labels, and protects main. Deploy from a laptop to rotate or rescope the token or to change the
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
  Effect.gen(function* stack() {
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
            // Account sessions/recovery and transactional sign-in email.
            "D1 Write",
            "Email Sending Write",
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

    const environment = yield* GitHub.Environment(
      "production",
      productionEnvironment(repo)
    );
    for (const [name, value] of Object.entries(productionVariables)) {
      yield* GitHub.Variable(name, { ...repo, environment, name, value });
    }

    for (const [name, description] of Object.entries(releaseLabels)) {
      yield* GitHub.Label(name, {
        ...repo,
        name,
        description,
        color: "2340c8",
      });
    }

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
