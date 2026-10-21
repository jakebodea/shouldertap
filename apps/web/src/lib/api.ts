import { ApiClient } from "@shouldertap/client";
import { parseToken } from "@shouldertap/domain";

import type { Pairing } from "@/lib/pairing";

export const api = new ApiClient({ baseUrl: import.meta.env.VITE_SERVER_URL });

/**
 * Tells the server this phone is done with a pairing, so the recipient's Mac
 * drops the sender. Best effort: the phone forgets the pairing either way.
 */
export const revokePairing = async (pairing: Pairing) => {
  try {
    // History uses the canonical sender ID; unlink only this device's key.
    const key = parseToken(pairing.token);
    if (key) {
      await api.withToken(pairing.token).revoke(key.id);
    }
  } catch {
    // Best effort: the phone forgets the pairing either way.
  }
};
