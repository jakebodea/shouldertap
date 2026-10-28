import { ApiError } from "@shouldertap/client";
import type { AccountConnection, Profile } from "@shouldertap/client";
import { fallbackColor, TAP_THEMES } from "@shouldertap/domain";
import type {
  QuickReplies,
  SendTapRequest,
  Tap,
  TapTheme,
} from "@shouldertap/domain";

import { connectionId, withConnection } from "./pairing";
import type { Pairing } from "./pairing";

/**
 * What this phone keeps for the sender's style: its own theme (for everyone
 * with no theme chosen for them on the account), their patron key, and an
 * unsent draft per pairing so leaving for checkout or the style page never
 * loses what they typed.
 * `storage` is `localStorage` in the app.
 */
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STYLE_KEY = "shouldertap.style.v1";
const PATRON_KEY = "shouldertap.patron.v1";
const draftKey = (credentialId: string) =>
  `shouldertap.draft.v1.${credentialId}`;

const safely = <A>(f: () => A, fallback: A): A => {
  try {
    return f();
  } catch {
    // Private mode or a full quota: this tab only.
    return fallback;
  }
};

/** Best effort: private mode or a full quota keeps it for this tab only. */
const attempt = (f: () => void) => {
  try {
    f();
  } catch {
    // Nothing kept.
  }
};

const isTheme = (value: unknown): value is TapTheme =>
  typeof value === "string" &&
  (TAP_THEMES as readonly string[]).includes(value);

export const loadStyle = (storage: Store): TapTheme =>
  safely(() => {
    const saved = storage.getItem(STYLE_KEY);
    return isTheme(saved) ? saved : "default";
  }, "default");

export const saveStyle = (storage: Store, theme: TapTheme) => {
  attempt(() => {
    storage.setItem(STYLE_KEY, theme);
  });
};

/** The theme taps to this person go in: the one chosen for them on the
 * account, else this browser's own. */
export const styleFor = (storage: Store, pairing: Pick<Pairing, "theme">) =>
  pairing.theme ?? loadStyle(storage);

/**
 * Chooses the theme taps to one person go in, on every device on the
 * account, keeping how they see you; returns the pairing as it is now. A
 * person the account doesn't hold (an old pairing it never had: 404) changes
 * this browser's own style instead, as before per-person themes. `save` is
 * `account.updateSendProfile`.
 */
export const chooseStyle = async (
  storage: Store,
  pairing: Pairing,
  theme: TapTheme,
  save: (
    id: string,
    profile: Profile & { readonly theme: TapTheme }
  ) => Promise<AccountConnection>
): Promise<Pairing> => {
  try {
    const saved = await save(connectionId(pairing), {
      name: pairing.senderName,
      color: pairing.color ?? fallbackColor(pairing.credentialId),
      theme,
    });
    return withConnection(pairing, saved);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 401)
    ) {
      saveStyle(storage, theme);
      return pairing;
    }
    throw error;
  }
};

/** The sender's patron key, or null. Never sent with a Default tap. */
export const loadPatronKey = (storage: Store): string | null =>
  safely(() => storage.getItem(PATRON_KEY), null);

export const savePatronKey = (storage: Store, key: string) => {
  attempt(() => {
    storage.setItem(PATRON_KEY, key);
  });
};

export const forgetPatronKey = (storage: Store) => {
  attempt(() => {
    storage.removeItem(PATRON_KEY);
  });
};

export const loadDraft = (storage: Store, credentialId: string): string =>
  safely(() => storage.getItem(draftKey(credentialId)) ?? "", "");

export const saveDraft = (
  storage: Store,
  credentialId: string,
  text: string
) => {
  attempt(() => {
    if (text) {
      storage.setItem(draftKey(credentialId), text);
    } else {
      storage.removeItem(draftKey(credentialId));
    }
  });
};

/**
 * The request for one send. The style is captured when the tap is composed
 * and kept with it in the outbox, so a retry asks for the same look. The key
 * only travels with a theme that needs it; the server decides what's stored.
 */
export const sendRequest = (
  item: {
    requestId: string;
    body: string;
    theme?: TapTheme;
    replies?: QuickReplies;
  },
  patronKey: string | null
): SendTapRequest => {
  const theme = item.theme ?? "default";
  const message = {
    requestId: item.requestId,
    body: item.body,
    ...(item.replies ? { replies: item.replies } : {}),
  };
  if (theme === "default") {
    return message;
  }
  return patronKey ? { ...message, theme, patronKey } : { ...message, theme };
};

/** Why a tap arrived in Default although the sender asked for a theme. */
export const downgradeNote = (
  requested: TapTheme | undefined,
  tap: Pick<Tap, "theme">
): string | null =>
  requested && requested !== "default" && (tap.theme ?? "default") === "default"
    ? "Sent in Default: patron support isn't active on this device."
    : null;
