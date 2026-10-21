import {
  Conflict,
  InvalidRequest,
  Unauthorized,
  Unavailable,
} from "@shouldertap/domain";
import * as Effect from "effect/Effect";

import {
  accountResources,
  ensureAccountPatron,
  reserveAccountBillingTarget,
  withAccountOperation,
} from "./account-identity";
import {
  createCheckout,
  customerPortal,
  retrieveCheckout,
  validatePatronProduct,
} from "./Creem";
import type { creemClient } from "./Creem";
import type { PatronRpc } from "./SenderPatron";

interface Dependencies {
  db: D1Database;
  patrons: { getByName: (id: string) => PatronRpc };
  enabled: boolean;
  billing?: { client: ReturnType<typeof creemClient>; patronProductId: string };
  origin: string;
}

/** New checkout needs the flag and a configured patron product; every page reads this. */
export const checkoutAvailable = (
  enabled: boolean,
  billing?: { patronProductId: string }
) => enabled && Boolean(billing?.patronProductId);

const checkoutMembership = Effect.fn(function* checkoutMembership(
  deps: Dependencies,
  billing: NonNullable<Dependencies["billing"]>,
  id: string
) {
  const stub = deps.patrons.getByName(id);
  yield* validatePatronProduct(billing.client, billing.patronProductId);
  let attempt = yield* stub.accountReserveCheckout();
  if (attempt.url && attempt.providerId) {
    const remote = yield* retrieveCheckout(billing.client, attempt.providerId);
    if (remote.status === "expired") {
      yield* stub.releaseExpiredCheckout(attempt.requestId);
      attempt = yield* stub.accountReserveCheckout();
    } else if (remote.status === "pending") {
      return { url: attempt.url };
    } else {
      return yield* new Conflict({
        message:
          "Checkout is processing or complete. Wait for your membership to update.",
      });
    }
  }
  if (attempt.url) {
    return { url: attempt.url };
  }
  const checkout = yield* createCheckout(billing.client, {
    productId: billing.patronProductId,
    patronId: id,
    requestId: attempt.requestId,
    successUrl: `${deps.origin}/account?section=patron`,
  });
  yield* stub.finishCheckout(attempt.requestId, checkout.id, checkout.url);
  return { url: checkout.url };
});

const selectedMembership = Effect.fn(function* selectedMembership(
  body: unknown,
  resources: { id: string }[]
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return yield* new InvalidRequest({ message: "Expected an object" });
  }
  const selected = "patronId" in body ? body.patronId : undefined;
  if (
    selected !== undefined &&
    (typeof selected !== "string" || !resources.some((r) => r.id === selected))
  ) {
    return yield* new Unauthorized({
      message: "Membership does not belong to this account",
    });
  }
  return selected;
});

const billingAction = Effect.fn(function* accountBilling(
  deps: Dependencies,
  userId: string,
  action: string,
  body: unknown
) {
  const resources = (yield* accountResources(deps.db, userId)).filter(
    (r) => r.kind === "patron"
  );
  const memberships = [];
  for (const resource of resources) {
    memberships.push({
      id: resource.id,
      name: resource.name,
      status: yield* deps.patrons.getByName(resource.id).accountStatus(),
    });
  }
  const checkoutEnabled = checkoutAvailable(deps.enabled, deps.billing);
  if (action === "status") {
    return { memberships, checkoutEnabled };
  }
  const selected = yield* selectedMembership(body, resources);
  if (action === "manage") {
    const id =
      selected ?? (resources.length === 1 ? resources[0]?.id : undefined);
    if (typeof id !== "string") {
      return yield* new Conflict({ message: "Choose a membership to manage" });
    }
    if (!deps.billing) {
      return yield* new Unavailable({ message: "Billing is unavailable here" });
    }
    const customer = yield* deps.patrons.getByName(id).accountCustomer();
    return { url: yield* customerPortal(deps.billing.client, customer) };
  }
  if (action !== "checkout") {
    return yield* new InvalidRequest({ message: "Unknown billing action" });
  }
  if (!checkoutEnabled || !deps.billing) {
    return yield* new Unavailable({
      message: "Patron memberships open soon.",
    });
  }
  // Do not sell a second subscription just because another identity was selected.
  if (memberships.some((m) => !m.status.patron.canSubscribe)) {
    return yield* new Conflict({
      message:
        "You already have a membership. Manage it instead of starting another subscription.",
    });
  }
  const id =
    typeof selected === "string"
      ? selected
      : yield* ensureAccountPatron(deps, userId);
  yield* reserveAccountBillingTarget(deps.db, userId, id);
  return yield* checkoutMembership(deps, deps.billing, id);
});

export const accountBilling = (
  deps: Dependencies,
  userId: string,
  action: string,
  body: unknown
) =>
  action === "checkout"
    ? withAccountOperation(
        deps.db,
        userId,
        "checkout",
        billingAction(deps, userId, action, body)
      )
    : billingAction(deps, userId, action, body);
