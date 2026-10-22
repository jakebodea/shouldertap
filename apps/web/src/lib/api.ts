import { ApiClient } from "@shouldertap/client";
import { parseToken } from "@shouldertap/domain";

import { account } from "@/lib/account";
import { inboxOf } from "@/lib/pairing";
import type { Pairing } from "@/lib/pairing";

export const api = new ApiClient({ baseUrl: import.meta.env.VITE_SERVER_URL });

/**
 * Stops tapping this person from every device on the account. Revoking only
 * this browser's key would come back on the next sync. Best effort: the
 * browser forgets the pairing either way.
 */
export const removePerson = async (pairing: Pairing) => {
  try {
    await account.removePerson(
      `${inboxOf(pairing.token)}:${pairing.credentialId}`
    );
  } catch {
    // Best effort, as above.
  }
};

/**
 * Unlinks only this browser's key, e.g. one replaced by a newer key for the
 * same person. Tells the server this phone is done with a pairing, so the recipient's Mac
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
