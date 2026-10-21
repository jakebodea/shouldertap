import { CreemCore } from "creem/core.js";
import { checkoutsCreate } from "creem/funcs/checkoutsCreate.js";
import { checkoutsRetrieve } from "creem/funcs/checkoutsRetrieve.js";
import { customersGenerateBillingLinks } from "creem/funcs/customersGenerateBillingLinks.js";
import { productsGet } from "creem/funcs/productsGet.js";
import { subscriptionsGet } from "creem/funcs/subscriptionsGet.js";
import { subscriptionEntityToJSON } from "creem/models/components/subscriptionentity.js";
import { parseWebhookEvent, verifyWebhookSignature } from "creem/webhooks.js";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { PatronEvent } from "./patron";

/**
 * Creem, the merchant of record: checkouts out, webhooks in. Checkout
 * metadata names who a payment belongs to, and Creem copies it to the
 * subscription, so every webhook names its billing subject.
 */

/** Historical: the recipient inbox of a one-time purchase or of receiver-owned
 * annual support. Still routed so those can be canceled and refunded, never
 * converted into a sender membership. */
export const INBOX_METADATA_KEY = "inbox_id";
/** Current: the sender's patron identity (SenderPatron). */
export const PATRON_METADATA_KEY = "patron_id";

/** Who a subscription fact belongs to. */
export type BillingOwner =
  | { readonly kind: "patron"; readonly id: string }
  | { readonly kind: "inbox"; readonly id: string };

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
    retryConfig: { strategy: "none" },
  });

export const createCheckout = (
  client: CreemCore,
  {
    productId,
    patronId,
    requestId,
  }: { productId: string; patronId: string; requestId: string }
) =>
  Effect.tryPromise({
    try: () =>
      checkoutsCreate(client, {
        productId,
        // Correlation only; the reservation prevents duplicate creation.
        requestId,
        // New memberships only ever belong to a sender's patron identity.
        metadata: { [PATRON_METADATA_KEY]: patronId },
      }),
    catch: (cause) =>
      new CreemError({ message: "Creem checkout request failed", cause }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok && result.value.checkoutUrl
        ? Effect.succeed({ id: result.value.id, url: result.value.checkoutUrl })
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
  | {
      readonly kind: "patron";
      /** Null when only the subscription id is known: look it up. */
      readonly owner: BillingOwner | null;
      readonly subscriptionId: string;
      readonly event: PatronEvent;
    }
  | { readonly kind: "ignore"; readonly reason: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null;
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const idOf = (value: unknown) => (isObject(value) ? str(value.id) : str(value));
const inboxIdOf = (checkout: unknown) =>
  isObject(checkout) && isObject(checkout.metadata)
    ? str(checkout.metadata[INBOX_METADATA_KEY])
    : null;

/** A sender patron id wins; an inbox id marks a historical receiver
 * subscription. Never both by construction. */
export const ownerOfMetadata = (metadata: unknown): BillingOwner | null => {
  if (!isObject(metadata)) {
    return null;
  }
  const patronId = str(metadata[PATRON_METADATA_KEY]);
  if (patronId) {
    return { kind: "patron", id: patronId };
  }
  const inboxId = str(metadata[INBOX_METADATA_KEY]);
  return inboxId ? { kind: "inbox", id: inboxId } : null;
};
const ownerOf = (value: unknown) =>
  isObject(value) ? ownerOfMetadata(value.metadata) : null;

const subscriptionTypes = new Set([
  "subscription.paid",
  "subscription.active",
  "subscription.canceled",
  "subscription.scheduled_cancel",
  "subscription.past_due",
  "subscription.unpaid",
  "subscription.expired",
  "subscription.paused",
]);

const subscriptionOf = (type: string, data: Json): Json | null => {
  if (type.startsWith("subscription.")) {
    return data;
  }
  return isObject(data.subscription) ? data.subscription : null;
};

const patronAction = (
  event: ReturnType<typeof parseWebhookEvent>,
  data: Json,
  productId?: string
): WebhookAction | null => {
  if (!subscriptionTypes.has(event.type) && event.type !== "refund.created") {
    return null;
  }
  const subscription = subscriptionOf(event.type, data);
  if (!subscription || !productId || idOf(subscription.product) !== productId) {
    return null;
  }
  const subscriptionId = idOf(subscription);
  const customerId = idOf(subscription.customer);
  const periodEnd =
    typeof subscription.current_period_end_date === "string"
      ? Date.parse(subscription.current_period_end_date)
      : 0;
  const at = event.createdAt;
  if (
    !event.id ||
    !finiteNumber(at) ||
    !subscriptionId ||
    !customerId ||
    !Number.isFinite(periodEnd)
  ) {
    throw new Error("Malformed patron event");
  }
  const transactionId = idOf(subscription.last_transaction_id);
  const refundTransactionId = idOf(data.transaction);
  if (
    event.type === "subscription.paid" &&
    (!transactionId || periodEnd <= 0)
  ) {
    throw new Error("Paid event missing transaction or period end");
  }
  if (event.type === "refund.created") {
    if (data.status !== "succeeded") {
      return { kind: "ignore", reason: "refund not succeeded" };
    }
    if (!refundTransactionId) {
      throw new Error("Refund missing transaction");
    }
  }
  return {
    kind: "patron",
    owner: ownerOf(subscription) ?? ownerOf(data.checkout),
    subscriptionId,
    event: {
      id: event.id,
      at,
      type: event.type,
      subscriptionId,
      customerId,
      periodEnd,
      transactionId,
      refundTransactionId:
        event.type === "refund.created" ? refundTransactionId : null,
    },
  };
};

/**
 * Reads the events Shouldertap acts on from a verified payload. Purchases of
 * any product but ours are ignored, so other products on the store are safe.
 */
export const webhookAction = (
  body: string,
  productId: string,
  patronProductId?: string
): WebhookAction => {
  const event = parseWebhookEvent(body);
  const data: unknown = event.data;
  if (!isObject(data)) {
    return { kind: "ignore", reason: "no event object" };
  }
  const patron = patronAction(event, data, patronProductId);
  if (patron) {
    return patron;
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
    if (typeof data.status === "string" && data.status !== "succeeded") {
      return { kind: "ignore", reason: "refund not succeeded" };
    }
    const orderId =
      idOf(data.order) ??
      (isObject(data.transaction) ? idOf(data.transaction.order) : null);
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

/** Refuse a misconfigured/legacy product before offering a recurring checkout. */
export const validatePatronProduct = (client: CreemCore, productId: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await productsGet(client, productId);
      if (!result.ok) {
        throw result.error;
      }
      const p = result.value;
      if (
        p.status !== "active" ||
        (p.trialPeriodDays ?? 0) > 0 ||
        (p.usagePrices?.length ?? 0) > 0 ||
        p.price !== 2400 ||
        p.currency !== "USD" ||
        p.billingType !== "recurring" ||
        p.billingPeriod !== "every-year"
      ) {
        throw new Error("Patron product must be USD 24 annually");
      }
    },
    catch: (cause) =>
      new CreemError({
        message: "Annual support is not configured correctly",
        cause,
      }),
  });

export const customerPortal = (client: CreemCore, customerId: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await customersGenerateBillingLinks(client, {
        customerId,
      });
      if (!result.ok) {
        throw result.error;
      }
      return result.value.customerPortalLink;
    },
    catch: (cause) =>
      new CreemError({ message: "Could not open billing management", cause }),
  });

/** Subscription metadata also routes renewals/refunds whose checkout is only an id. */
export const subscriptionOwner = (client: CreemCore, subscriptionId: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await subscriptionsGet(client, subscriptionId);
      if (!result.ok) {
        throw result.error;
      }
      return ownerOfMetadata(result.value.metadata);
    },
    catch: (cause) =>
      new CreemError({ message: "Subscription lookup failed", cause }),
  });

/** Some refund payloads contain only a subscription id. Resolve that real
 * provider boundary before applying the same product/metadata validation. */
export const readWebhookAction = (
  client: CreemCore,
  body: string,
  legacyProductId: string,
  patronProductId: string
) =>
  Effect.gen(function* readAction() {
    const event = yield* Effect.try(() => parseWebhookEvent(body));
    if (event.type !== "refund.created" || !isObject(event.data)) {
      return yield* Effect.try(() =>
        webhookAction(body, legacyProductId, patronProductId)
      );
    }
    const { data } = event;
    const subscriptionId =
      typeof data.subscription === "string" ? data.subscription : null;
    if (!subscriptionId) {
      return yield* Effect.try(() =>
        webhookAction(body, legacyProductId, patronProductId)
      );
    }
    const result = yield* Effect.tryPromise({
      try: () => subscriptionsGet(client, subscriptionId),
      catch: (cause) =>
        new CreemError({ message: "Refund subscription lookup failed", cause }),
    });
    if (!result.ok) {
      return yield* new CreemError({
        message: "Refund subscription lookup failed",
        cause: result.error,
      });
    }
    const expanded = JSON.parse(subscriptionEntityToJSON(result.value));
    const hydrated = JSON.stringify({
      ...event.raw,
      object: { ...data, subscription: expanded },
      data: { ...data, subscription: expanded },
    });
    return yield* Effect.try(() =>
      webhookAction(hydrated, legacyProductId, patronProductId)
    );
  });

export const retrieveCheckout = (client: CreemCore, id: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await checkoutsRetrieve(client, id);
      if (!result.ok) {
        throw result.error;
      }
      return { status: result.value.status, url: result.value.checkoutUrl };
    },
    catch: (cause) =>
      new CreemError({ message: "Checkout lookup failed", cause }),
  });
