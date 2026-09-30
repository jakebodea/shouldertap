import type { PersonColor } from "@shouldertap/domain";

export interface Pairing {
  /** Missing on pairings made before colors; the snapshot fills it in. */
  readonly color?: PersonColor;
  readonly credentialId: string;
  readonly recipientName: string;
  readonly senderName: string;
  readonly token: string;
}

const KEY = "shouldertap.pairing.v1";

export const loadPairing = (): Pairing | null => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    return null;
  }
};

export const savePairing = (pairing: Pairing) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(pairing));
  } catch {
    // Private mode: the pairing lasts for this tab only.
  }
};

export const clearPairing = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
};
