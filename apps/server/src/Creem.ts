import { CreemCore } from "creem/core.js";
import { checkoutsCreate } from "creem/funcs/checkoutsCreate.js";
import { checkoutsRetrieve } from "creem/funcs/checkoutsRetrieve.js";
import { parseWebhookEvent, verifyWebhookSignature } from "creem/webhooks.js";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Creem, the merchant of record: checkouts out, webhooks in. The inbox id
 * rides in checkout metadata, so every webhook names the inbox it's for.
 */

/** Checkout metadata key carrying the inbox being paid for. */
export const INBOX_METADATA_KEY = "inbox_id";

export class CreemError extends Data.TaggedError("CreemError")<{
  message: string;
  cause?: unknown;
}> {}

/** Test keys talk to Creem's sandbox; anything else is live. */
export const creemClient = (apiKey: string) =>
  new CreemCore({
    apiKey,
    server: apiKey.startsWith("creem_test_") ? "test" : "prod",
    timeoutMs: 10_000,
  });

export const createCheckout = (
  client: CreemCore,
  { productId, inboxId }: { productId: string; inboxId: string }
) =>
  Effect.tryPromise({
    try: () =>
      checkoutsCreate(client, {
        productId,
        // One open checkout per inbox; Creem uses it to correlate retries.
        requestId: `inbox-${inboxId}`,
        metadata: { [INBOX_METADATA_KEY]: inboxId },
      }),
    catch: (cause) =>
      new CreemError({ message: "Creem checkout request failed", cause }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok && result.value.checkoutUrl
        ? Effect.succeed(result.value.checkoutUrl)
        : Effect.fail(
            new CreemError({
              message: "Creem didn't return a checkout URL",
              cause: result.ok ? undefined : result.error,
            })
          )
    )
  );

/** Rejects anything not signed with the webhook's secret. */
export const verifyWebhook = (
  body: string,
  headers: Record<string, string | undefined>,
  secret: string
) =>
  Effect.tryPromise({
    try: () => verifyWebhookSignature(body, headers, { secret }),
    catch: (cause) =>
      new CreemError({ message: "Invalid Creem webhook signature", cause }),
  });

/** What a verified webhook asks of an inbox. */
export type WebhookAction =
  | {
      readonly kind: "purchase";
      readonly inboxId: string;
      readonly orderId: string;
      readonly email: string | null;
    }
  | {
      readonly kind: "refund";
      readonly orderId: string;
      /** Missing when Creem sends the checkout as a bare id. */
      readonly inboxId: string | null;
      readonly checkoutId: string | null;
    }
  | { readonly kind: "ignore"; readonly reason: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null;
const str = (value: unknown) => (typeof value === "string" ? value : null);
const idOf = (value: unknown) => (isObject(value) ? str(value.id) : str(value));
const inboxIdOf = (checkout: unknown) =>
  isObject(checkout) && isObject(checkout.metadata)
    ? str(checkout.metadata[INBOX_METADATA_KEY])
    : null;

/**
 * Reads the events Shouldertap acts on from a verified payload. Purchases of
 * any product but ours are ignored, so other products on the store are safe.
 */
export const webhookAction = (
  body: string,
  productId: string
): WebhookAction => {
  const event = parseWebhookEvent(body);
  const data: unknown = event.data;
  if (!isObject(data)) {
    return { kind: "ignore", reason: "no event object" };
  }
  if (event.type === "checkout.completed") {
    const inboxId = inboxIdOf(data);
    const orderId = idOf(data.order);
    const product =
      idOf(data.product) ??
      (isObject(data.order) ? str(data.order.product) : null);
    if (product !== productId) {
      return { kind: "ignore", reason: `other product ${product}` };
    }
    if (!(inboxId && orderId)) {
      return { kind: "ignore", reason: "checkout without inbox or order" };
    }
    const email = isObject(data.customer) ? str(data.customer.email) : null;
    return { kind: "purchase", inboxId, orderId, email };
  }
  if (event.type === "refund.created") {
    const orderId = idOf(data.order);
    if (!orderId) {
      return { kind: "ignore", reason: "refund without order" };
    }
    return {
      kind: "refund",
      orderId,
      inboxId: inboxIdOf(data.checkout),
      checkoutId: idOf(data.checkout),
    };
  }
  return { kind: "ignore", reason: `unhandled ${event.type}` };
};

/** The inbox a checkout was for, from its metadata. */
export const checkoutInboxId = (client: CreemCore, checkoutId: string) =>
  Effect.tryPromise({
    try: () => checkoutsRetrieve(client, checkoutId),
    catch: (cause) =>
      new CreemError({ message: "Creem checkout lookup failed", cause }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(
            str(result.value.metadata?.[INBOX_METADATA_KEY]) ?? null
          )
        : Effect.fail(
            new CreemError({
              message: "Creem checkout lookup failed",
              cause: result.error,
            })
          )
    )
  );
