import { ApiError } from "@shouldertap/client";
import type { PatronLinkCode, PatronStatus } from "@shouldertap/domain";
import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { forgetPatronKey, loadPatronKey, savePatronKey } from "./sender-style";

/**
 * The sender's own patron membership, read with the patron key this phone
 * holds. It belongs to the sender, not to anyone they tap: one membership
 * styles taps to all of them. Checkout opens in a new tab where it can, so
 * the composer (and its saved draft) stays put; coming back refreshes.
 */
export const usePatron = () => {
  const [key, setKey] = useState(() => loadPatronKey(localStorage));
  const [fetched, setFetched] = useState<{
    key: string;
    status: PatronStatus;
  } | null>(null);
  // Only the status read with the key this phone holds now counts.
  const status = key && fetched?.key === key ? fetched.status : null;
  const loaded = key === null || status !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!key) {
      return;
    }
    try {
      setFetched({ key, status: await api.withPatronKey(key).patronStatus() });
    } catch (error_) {
      if (error_ instanceof ApiError && error_.code === "unauthorized") {
        // Forgotten from another device, or never valid: start over.
        forgetPatronKey(localStorage);
        setKey(null);
      }
    }
  }, [key]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- a network read: state is set only after its await
    refresh();
    const wake = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  const run = useCallback(async <A>(action: () => Promise<A>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setBusy(false);
      return result;
    } catch (error_) {
      setBusy(false);
      setError(
        error_ instanceof ApiError && error_.code !== "network"
          ? error_.message
          : "Couldn't reach Shouldertap. Try again."
      );
      return null;
    }
  }, []);

  /** Opens a provider page in a new tab, or here if the browser blocks it. */
  const openOutside = useCallback(
    async (url: () => Promise<{ url: string } | null>) => {
      // Opened during the click, so it isn't treated as a popup.
      const tab = window.open("", "_blank");
      const result = await url();
      if (!result) {
        tab?.close();
        return;
      }
      if (tab) {
        tab.opener = null;
        tab.location.href = result.url;
      } else {
        window.location.assign(result.url);
      }
    },
    []
  );

  // Buying starts with an account. The account page explicitly adopts any
  // existing browser membership before it opens account-owned checkout.
  const subscribe = useCallback(() => {
    window.location.assign("/account?intent=patron");
  }, []);

  const manage = useCallback(
    () =>
      openOutside(() =>
        run(() =>
          key
            ? api.withPatronKey(key).patronManage()
            : Promise.reject(new Error("No patron key"))
        )
      ),
    [key, openOutside, run]
  );

  const linkCode = useCallback(
    (): Promise<PatronLinkCode | null> =>
      key
        ? run(() => api.withPatronKey(key).patronLinkCode())
        : Promise.resolve(null),
    [key, run]
  );

  /** A code from another of the sender's devices adds this one. */
  const redeem = useCallback(
    (code: string) =>
      run(async () => {
        const grant = await api.redeemPatronLink(code.trim());
        savePatronKey(localStorage, grant.key);
        setKey(grant.key);
        return grant;
      }),
    [run]
  );

  const forget = useCallback(
    () =>
      run(async () => {
        if (key) {
          await api
            .withPatronKey(key)
            .forgetPatronKey()
            .catch(() => null);
        }
        forgetPatronKey(localStorage);
        setKey(null);
      }),
    [key, run]
  );

  return {
    hasKey: key !== null,
    status,
    active: status?.patron.active ?? false,
    loaded,
    busy,
    error,
    subscribe,
    manage,
    linkCode,
    redeem,
    forget,
    refresh,
  };
};
