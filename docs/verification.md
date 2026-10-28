# Verification environments

Use this runner to exercise real application logic in an isolated stack and keep reviewable evidence. Use [proofed delivery](proofed-delivery.md) to bind checks, review and artifacts to a committed change. A passing browser run does not prove native rendering, physical push delivery or Windows desktop behavior.

## Run locally

From the repository root:

```sh
bun install --frozen-lockfile
bun run verify:doctor
bun run verify -- --local --scenario browser
```

`verify:doctor` checks Bun/Git and prints prerequisites; it does not establish Cloudflare access, installed browsers or a working app. Install Playwright WebKit once if it is missing: `cd apps/web && bunx playwright install webkit`.

Local runs need Alchemy Cloudflare authentication/state setup. Explicit shell credentials take precedence over the selected profile. They run the actual Worker, Durable Objects, D1 migrations and web app through local workerd, on allocated ports. They do not read Infisical app secrets. The runner ignores the repository `.env` for Alchemy startup and removes billing, APNs and analytics credentials from child environments. Do not edit the production state setup to make a local test work.

The browser scenario uses two fresh browser contexts and real email-code sign-in, profile, invite, acceptance and composer UI. A protocol client receives the tap, reports display and replies; the browser must show the result and retain it after reload. The suite also rejects an incorrect OTP and an unrelated account origin. Its receipt explicitly records that native UI was not exercised.

## Run the native foreground journey

On this Mac, use the device tools to list devices and open the first available shared `agent-sim-1`, `agent-sim-2`, `agent-sim-3` or `agent-sim-ipad`. Never create or clone a simulator. If none is available, stop rather than claiming a skip as success. From the exact launcher and target flags returned by `device_open`, set:

- `SHOULDERTAP_DEVICE_COMMAND`: the returned executable path.
- `SHOULDERTAP_DEVICE_ARGS`: a JSON array of its target flags, including `--udid` and the selected device identifier. Preserve any other returned targeting flags.

Then run:

```sh
bun run verify -- --local --scenario core
```

Core builds a fresh Debug iPhone app for that simulator, installs `app.shouldertap.iphone.debug`, and passes the run ID and both endpoints as launch arguments. It drives onboarding and invite creation through accessibility identifiers. A fresh browser sender accepts that invite and sends `Verification native foreground tap`. The driver checks the rendered message, captures the takeover, waits for the app's display receipt, presses **On it**, and requires the browser to show that reply and the native takeover to dismiss. There are no protocol calls substituting for native display or reply actions.

The run namespaces native credentials/defaults, records the built executable's SHA-256 and clears its own state afterward. The driver closes its app; the device controller/caller remains responsible for releasing the simulator it acquired. Shut down only a simulator you booted: `xcrun simctl shutdown <udid>`. Never use `shutdown all` or erase a simulator another agent is using.

## Hosted verification

```sh
bun run verify -- --hosted --scenario browser
```

Supply `CLOUDFLARE_TEST_API_TOKEN` and `CLOUDFLARE_TEST_ACCOUNT_ID` through the approved secret-delivery mechanism. The account ID may be the existing production account: a second account is optional. Use a dedicated test token without production DNS/zone permissions. The runner requires explicit test credentials and never silently falls back to the production token. Unique stages, production-stage rejection and ownership-checked cleanup isolate ordinary test runs within one account. Account-wide Worker permissions still give that token broader authority than a separate account would. Workers, Durable Objects, D1 and Alchemy's state storage must be available in the selected account.

Each run allocates `verify-<timestamp>-<random>` resources. Hosted startup first deploys to discover API/web URLs, then deploys their exact auth origins. It verifies `/version` against the checked-out commit before the protocol and UI scenarios. A unique stage and stage-prefixed rate-limit keys separate concurrent runs.

## External boundaries

Verification deployments keep OTP generation, validation, sessions and account sync real. Only email delivery is replaced with a private D1 mailbox. The runner uses a generated per-run bearer token to read `GET /__verify/mail?email=…`; `DELETE` clears it. Codes expire from mailbox reads after ten minutes. No browser CORS access is granted. These bindings/routes are absent from production and ordinary `pr-*` previews. Ordinary previews therefore still cannot deliver OTPs; use a `verify-*` run for full sign-in verification.

Verification APNs delivery uses a recorder at `/__verify/push`, under the same private bearer. `GET` reads recorded requests, `DELETE` clears requests and the configured response, and `PUT` configures a simulated response, such as `{"status":410,"reason":"Unregistered"}`. This exercises payload generation and provider failure handling, not Apple's delivery network or iOS background rules. Billing remains off in ordinary runs; fixture/provider tests and the explicit Creem sandbox workflow cover separate boundaries. No real charge is created by these verification commands.

## Evidence and cleanup

- `.artifacts/verification/<stage>/`: public receipt, backend identity, controlled composer/takeover screenshots and native binary/result metadata when exercised.
- `.verification/<stage>/`: private command logs, ownership/exchange files, sign-in details, browser JSON report, Playwright output/error-context files and build output. Do not upload this tree.

`SHOULDERTAP_VERIFY_OUTPUT` keeps Playwright output private; only explicit composer screenshots are also written to `SHOULDERTAP_VERIFY_ARTIFACTS`. Traces, video and automatic browser failure screenshots are disabled: auth bodies, cookies and invite fragments can contain credentials. The runner retains detailed failure logs privately and publishes exit status plus log digests. Review explicit screenshots before sharing. A receipt records the source revision, working-tree digest, merge base, scenario, backend URLs, executed steps, cleanup and limitations. If source changes during the run, the result fails. A dirty-tree runtime receipt is diagnostic evidence, not committed revision-bound proof.

Cleanup runs on normal success/failure and accepts only verification-stage names. After an interrupted run, recover using its ownership file and the same account:

```sh
bun run verify:cleanup -- --run verify-<timestamp>-<random>
```

Use the hosted cleanup option with the test-account credentials for hosted resources. The scheduled preview cleanup also discovers expired verification stages by their encoded creation time; it is an orphan-recovery path, not proof that a particular run cleaned up. Never substitute `prod`, `dev` or an arbitrary stage in cleanup commands.

## CI rollout and remaining gates

`Deploy` calls the reusable native workflow and hosted browser verification. The always-running `verification` job rejects failed, cancelled, missing or skipped required checks, including a preview job that skipped deployment. The ordinary PR preview runs a one-inbox revision/send/display/reply protocol smoke. The isolated verification stage runs the full protocol suite, including its separate rate-limit flood identity, so flood tests cannot disrupt ordinary preview journeys. Fork code never receives cloud credentials; a maintainer must move reviewed changes to a trusted repository branch for full verification before merge. Main production deployment waits on the aggregate. Release checks for a successful exact-revision aggregate and checks out that source, rather than releasing a newer main checkout by chance.

Before enabling this in GitHub:

1. Review the `stacks/github.ts` operator update. It defines a dedicated verification token in the existing account and the two `CLOUDFLARE_TEST_*` repository secrets; it does not create another account.
2. Have the operator apply that infrastructure update. This implementation does not generate credentials or change GitHub settings by itself. A separate account can instead be selected through explicitly provisioned CI test credentials.
3. If changing accounts, handle old previews in the previous account through the operator. Keeping the existing account preserves their discovery and cleanup.
4. Run hosted verification on the actual runner and inspect retained evidence.
5. Apply the reviewed `stacks/github.ts` ruleset update through the operator workflow. Its configured required check is `verification`; editing the file alone does not change live branch protection.

Native CI currently compiles/packages and tests core logic. It does not execute the interactive native foreground driver. Run core locally for relevant changes. Release verification must separately record physical iPhone APNs/Live Activity behavior, a real Creem sandbox lifecycle, and Windows runtime installation, tray/overlay/focus/update behavior. Multi-receiver dismissal, sleep/wake, offline recovery and migration/upgrade journeys need further dedicated scenarios.

## Check that verification can fail

Use a disposable branch and restore each intentional defect afterward:

- Break the native takeover text or **On it** action: core must fail on rendered message/display/reply or dismissal, with no substitute acknowledgement.
- Break browser reply rendering: browser verification must fail even if protocol acknowledgement succeeded.
- Supply a wrong deployment revision: the deployment identity check must fail before scenarios run.
- Make a required CI result `skipped` or a preview deployment unexecuted: the aggregate policy must fail. Its focused tests cover these cases.
- Alter a proof artifact, receipt/report or advance the base: `proof verify` must reject the stale/tampered bundle.
- Run two browser scenarios from separate worktrees concurrently: both must finish without sharing ports, credentials, state or cleanup targets. Treat concurrency as unverified until that experiment has actually run.
