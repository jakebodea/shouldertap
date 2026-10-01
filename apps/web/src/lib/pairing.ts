import { type PersonColor, parseToken } from "@shouldertap/domain";

/**
 * One person this phone can tap. A phone can hold several pairings, each its
 * own sender credential in that person's inbox, like the native apps.
 */
export interface Pairing {
  /** Missing on pairings made before colors; the snapshot fills it in. */
  readonly color?: PersonColor;
  readonly credentialId: string;
  readonly recipientName: string;
  readonly senderName: string;
  readonly token: string;
}

interface Stored {
  readonly pairings: readonly Pairing[];
  /** The credential the composer shows; falls back to the first pairing. */
  readonly selected: string | null;
}

const KEY = "shouldertap.pairings.v2";
const LEGACY_KEY = "shouldertap.pairing.v1";
const LEGACY_OUTBOX_KEY = "shouldertap.outbox.v1";

/** Unsent taps are kept per pairing, so a retry uses the right token. */
export const outboxKey = (credentialId: string) =>
  `shouldertap.outbox.v2.${credentialId}`;

/** The recipient's inbox, from a credential token or an invite code. */
export const inboxOf = (tokenOrCode: string) =>
  parseToken(tokenOrCode)?.inboxId ?? null;

const EMPTY: Stored = { pairings: [], selected: null };

/** Moves a phone that held one pairing (and one outbox) to the list. */
const migrate = (): Stored => {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) {
    return EMPTY;
  }
  const pairing = JSON.parse(raw) as Pairing;
  const stored: Stored = {
    pairings: [pairing],
    selected: pairing.credentialId,
  };
  localStorage.setItem(KEY, JSON.stringify(stored));
  const outbox = localStorage.getItem(LEGACY_OUTBOX_KEY);
  if (outbox) {
    localStorage.setItem(outboxKey(pairing.credentialId), outbox);
  }
  localStorage.removeItem(LEGACY_OUTBOX_KEY);
  localStorage.removeItem(LEGACY_KEY);
  return stored;
};

const load = (): Stored => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : migrate();
  } catch {
    return EMPTY;
  }
};

const store = (stored: Stored) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Private mode: the pairing lasts for this tab only.
  }
};

export const loadPairings = (): readonly Pairing[] => load().pairings;

/** The pairing the composer shows, or null on an unpaired phone. */
export const loadPairing = (): Pairing | null => {
  const { pairings, selected } = load();
  return (
    pairings.find((p) => p.credentialId === selected) ?? pairings[0] ?? null
  );
};

/** The pairing with the person an invite code is from, if any. */
export const pairingForCode = (code: string): Pairing | null => {
  const inboxId = inboxOf(code);
  return inboxId
    ? (loadPairings().find((p) => inboxOf(p.token) === inboxId) ?? null)
    : null;
};

/**
 * Adds a new pairing and shows it. Pairing again with the same person
 * replaces the old one, as on the native apps; the replaced pairings are
 * returned so the caller can revoke them.
 */
export const addPairing = (pairing: Pairing): Pairing[] => {
  const inboxId = inboxOf(pairing.token);
  const stored = load().pairings;
  const replaced = (p: Pairing) =>
    p.credentialId !== pairing.credentialId && inboxOf(p.token) === inboxId;
  const others = stored.filter(
    (p) => p.credentialId !== pairing.credentialId && !replaced(p)
  );
  store({ pairings: [...others, pairing], selected: pairing.credentialId });
  return stored.filter(replaced);
};

/** Rewrites a pairing in place, e.g. once its color is known. */
export const updatePairing = (pairing: Pairing) => {
  const stored = load();
  store({
    ...stored,
    pairings: stored.pairings.map((p) =>
      p.credentialId === pairing.credentialId ? pairing : p
    ),
  });
};

export const selectPairing = (credentialId: string) =>
  store({ ...load(), selected: credentialId });

export const removePairing = (credentialId: string) => {
  const stored = load();
  store({
    pairings: stored.pairings.filter((p) => p.credentialId !== credentialId),
    selected: stored.selected === credentialId ? null : stored.selected,
  });
  try {
    localStorage.removeItem(outboxKey(credentialId));
  } catch {
    // Nothing stored.
  }
};
