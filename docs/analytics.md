# Product analytics

The server reports account creation, inbox creation, invite acceptance, tap sends, answers, and patron subscription facts to PostHog US Cloud. No client SDK is loaded. Payload fields are explicitly selected in `apps/server/src/analytics.ts`; names, message text, reply text, credentials, and client IPs are excluded.

The one piece of profile data sent is an account's sign-in email: `account_created` sets it on the account's PostHog person (`$set`), so sign-up alerts and the person profile show who signed up, and `account_deleted` removes it from the person (`$unset`). The `account_created` event itself keeps the `$set` copy; erasing that needs a person deletion with events in PostHog, done by hand on request. Inboxes and senders without an account have no email and stay anonymous.

The production project is [Shouldertap](https://us.posthog.com/project/684025) in the Shouldertap organization. IP collection is disabled in the project settings.

## Enable production

1. The owner adds the project token from PostHog project settings to Infisical `shouldertap-prod`, environment `prod`, as `POSTHOG_PROJECT_TOKEN`. All agent identities are read-only; never write production secrets from scripts.
2. Merge and deploy the analytics change. Without the token, tracking is a no-op.
3. Connect the PostHog Slack integration to `jbolabs`, then add a Slack destination for `account_created`, `inbox_created`, `patron_subscribed`, and `patron_canceled` targeting `#shouldertap-events`. Keep tap events out of Slack to avoid noise. Show the email with `{person.properties.email ?? event.properties.$set.email ?? 'no account'}`.
4. Verify a real product action in PostHog Activity and its Slack notification. Update the App Store privacy disclosure for linked product interaction data before enabling production collection.

## Identity and delivery

Account-owned inboxes, sender credentials, and patron identities resolve through verified `account_resource` ownership to the account ID. Unclaimed legacy resources use their existing random resource IDs. Events sent before a resource is adopted are not retroactively merged into an account.

Delivery runs in the Worker execution context after scheduling and does not wait for PostHog in the product request. It is best effort: failures are logged, with no persistent retry queue. Stable event UUIDs and stored tap timestamps make repeated tap requests deduplicable. This is not an exactly-once delivery guarantee.
