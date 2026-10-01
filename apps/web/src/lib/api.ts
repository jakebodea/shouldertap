import { ApiClient } from "@shouldertap/client";

import type { Pairing } from "@/lib/pairing";

export const api = new ApiClient({ baseUrl: import.meta.env.VITE_SERVER_URL });

/**
 * Tells the server this phone is done with a pairing, so the recipient's Mac
 * drops the sender. Best effort: the phone forgets the pairing either way.
 */
export const revokePairing = (pairing: Pairing) => {
  api
    .withToken(pairing.token)
    .revoke(pairing.credentialId)
    .catch(() => undefined);
};
