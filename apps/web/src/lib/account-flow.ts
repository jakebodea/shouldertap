/**
 * Where the sender was headed when they left for the account portal. The
 * sign-in email can open in a new tab, so this rides in `localStorage`
 * (never a credential) and expires on its own.
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
 * What the account page offers for patron support on this browser. A
 * membership already here is never replaced by another one, and checkout is
 * offered only when the server says it is open.
 */
export type PatronPlan =
  /** This browser holds one of the account's memberships. */
  | { kind: "here" }
  /** The account has a membership this browser can add. */
  | { kind: "use"; patronId: string }
  /** This browser has a different membership; it stays. */
  | { kind: "kept" }
  /** This browser's membership isn't saved to the account yet. */
  | { kind: "save" }
  | { kind: "checkout" }
  | { kind: "soon" };

export const patronPlan = ({
  localPatronId,
  accountPatronIds,
  checkoutEnabled,
}: {
  localPatronId: string | null;
  accountPatronIds: readonly string[];
  checkoutEnabled: boolean;
}): PatronPlan => {
  if (localPatronId) {
    if (accountPatronIds.includes(localPatronId)) {
      return { kind: "here" };
    }
    return accountPatronIds.length ? { kind: "kept" } : { kind: "save" };
  }
  const [first] = accountPatronIds;
  if (first) {
    return { kind: "use", patronId: first };
  }
  return checkoutEnabled ? { kind: "checkout" } : { kind: "soon" };
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
