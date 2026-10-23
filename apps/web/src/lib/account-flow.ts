/**
 * Where the sender was headed when they opened the account page. Signing
 * in can take a detour (another tab, a phone), so this rides in
 * `localStorage` (never a credential) and expires on its own.
 */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const INTENT_KEY = "shouldertap.account.intent.v1";
const INTENT_TTL = 60 * 60 * 1000;

export type AccountIntent = "patron";

export const rememberIntent = (
  storage: Store,
  intent: AccountIntent,
  now: number
) => {
  try {
    storage.setItem(INTENT_KEY, JSON.stringify({ intent, at: now }));
  } catch {
    // Private mode: the intent lasts for this page only.
  }
};

/** A query `intent` wins; otherwise one remembered within the last hour. */
export const resolveIntent = (
  storage: Store,
  search: string,
  now: number
): AccountIntent | null => {
  if (new URLSearchParams(search).get("intent") === "patron") {
    rememberIntent(storage, "patron", now);
    return "patron";
  }
  try {
    const saved: unknown = JSON.parse(storage.getItem(INTENT_KEY) ?? "null");
    if (
      saved &&
      typeof saved === "object" &&
      "intent" in saved &&
      saved.intent === "patron" &&
      "at" in saved &&
      typeof saved.at === "number" &&
      now - saved.at < INTENT_TTL
    ) {
      return "patron";
    }
    storage.removeItem(INTENT_KEY);
  } catch {
    // Unreadable: no intent.
  }
  return null;
};

export const forgetIntent = (storage: Store) => {
  try {
    storage.removeItem(INTENT_KEY);
  } catch {
    // Nothing kept.
  }
};

/**
 * What the account page offers for patron support on this browser. Only an
 * active membership makes someone a patron: an account can hold a membership
 * with no subscription (a checkout that was never finished), and that one is
 * offered for checkout, not for use. A membership already on this browser is
 * never replaced by another one, and checkout is offered only when the
 * server says it is open.
 */
export type PatronPlan =
  /** This browser holds one of the account's active memberships. */
  | { kind: "here" }
  /** The account has an active membership this browser can add. */
  | { kind: "use"; patronId: string }
  /** More than one active membership requires an explicit choice. */
  | { kind: "choose" }
  /**
   * This browser holds another membership, which stays. `saved`: it is
   * already on the account (just not active).
   */
  | { kind: "kept"; saved: boolean }
  /** This browser's membership isn't saved to the account yet. */
  | { kind: "save" }
  /**
   * Not active, and the server won't sell another subscription (paused, or
   * still being billed): manage it instead.
   */
  | { kind: "lapsed" }
  /** Not a patron: subscribe, reusing the account's unpaid membership. */
  | { kind: "checkout"; patronId?: string }
  | { kind: "soon" };

export const patronPlan = ({
  localPatronId,
  memberships,
  checkoutEnabled,
}: {
  localPatronId: string | null;
  /** Billing facts; unknown (billing didn't load) counts as active. */
  memberships: readonly {
    id: string;
    active: boolean;
    canSubscribe: boolean;
  }[];
  checkoutEnabled: boolean;
}): PatronPlan => {
  const active = memberships.filter((m) => m.active).map((m) => m.id);
  const saved = memberships.some((m) => m.id === localPatronId);
  if (localPatronId && active.includes(localPatronId)) {
    return { kind: "here" };
  }
  // Never replace a membership already on this browser.
  if (localPatronId && active.length) {
    return { kind: "kept", saved };
  }
  if (localPatronId && !saved) {
    return { kind: "save" };
  }
  if (active.length > 1) {
    return { kind: "choose" };
  }
  const [first] = active;
  if (first) {
    return { kind: "use", patronId: first };
  }
  // The server sells a subscription only when every membership allows one.
  if (memberships.some((m) => !m.canSubscribe)) {
    return { kind: "lapsed" };
  }
  if (!checkoutEnabled) {
    return { kind: "soon" };
  }
  const unpaid = localPatronId ?? memberships[0]?.id;
  return unpaid ? { kind: "checkout", patronId: unpaid } : { kind: "checkout" };
};

/** Style's patron call to action for a sender without an active membership. */
export const styleOffer = ({
  canManage,
  canSubscribe,
  checkoutEnabled,
}: {
  canManage: boolean;
  canSubscribe: boolean;
  checkoutEnabled: boolean | null;
}): "manage" | "subscribe" | "soon" => {
  if (canManage && !canSubscribe) {
    return "manage";
  }
  return checkoutEnabled ? "subscribe" : "soon";
};

interface MembershipChoice {
  id: string;
  name: string;
  billing?: { status: string; paidUntil: number | null };
}

/** Only enable choices that the available billing facts let a person distinguish. */
export const membershipChoices = <M extends MembershipChoice>(
  memberships: readonly M[]
) => {
  const labels: Record<string, string> = {
    none: "No subscription",
    active: "Active",
    ending: "Ending",
    payment_issue: "Payment issue",
    inactive: "Inactive",
  };
  const choices = memberships.map((membership) => {
    const { billing } = membership;
    const date = billing?.paidUntil
      ? new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(billing.paidUntil)
      : null;
    const detail = billing
      ? `${labels[billing.status] ?? "Status unavailable"}${date ? ` · Paid through ${date}` : ""}`
      : "Membership details unavailable";
    return { ...membership, detail };
  });
  return choices.map((choice) => ({
    ...choice,
    canChoose:
      Boolean(choice.billing) &&
      choices.filter(
        (other) => other.name === choice.name && other.detail === choice.detail
      ).length === 1,
  }));
};
