import {
  ApiError,
  connectLive,
  isRetryable,
  mergeSnapshot,
  mergeTap,
} from "@shouldertap/client";
import type { LiveStatus } from "@shouldertap/client";
import type { PersonColor, Tap, TapTheme } from "@shouldertap/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import { newRequestId } from "./ids";
import { migrateBillingRefusal } from "./outbox-migration";
import { outboxKey } from "./pairing";
import type { Pairing } from "./pairing";
import { loadPatronKey, sendRequest } from "./sender-style";

export interface OutgoingTap {
  readonly body: string;
  readonly createdAt: number;
  /** Why the server refused it, e.g. the hourly limit. */
  readonly error?: string;
  readonly failed: boolean;
  /** Historical billing refusal; retired when loading the saved outbox. */
  readonly paused?: boolean;
  readonly requestId: string;
  /** The style chosen when it was written; missing on older saved taps. */
  readonly theme?: TapTheme;
}

const loadOutbox = (credentialId: string): OutgoingTap[] => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(outboxKey(credentialId)) ?? "[]"
    ) as OutgoingTap[];
    return saved.map((item) => migrateBillingRefusal(item));
  } catch {
    return [];
  }
};

const saveOutbox = (credentialId: string, outbox: readonly OutgoingTap[]) => {
  try {
    localStorage.setItem(outboxKey(credentialId), JSON.stringify(outbox));
  } catch {
    // Best effort.
  }
};

/**
 * Sender state: the authoritative snapshot, live updates, and an outbox of
 * sends that haven't been accepted yet. Each send keeps its request id, so
 * a retry after a dropped connection can't create a duplicate tap. The
 * outbox is read once, so render one sender per pairing (key it by the
 * credential) rather than swapping the pairing underneath it.
 */
export const useSender = (pairing: Pairing, onRevoked: () => void) => {
  const client = useMemo(() => api.withToken(pairing.token), [pairing.token]);
  const [taps, setTaps] = useState<Tap[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [loaded, setLoaded] = useState(false);
  const [senderColor, setSenderColor] = useState<PersonColor | null>(null);
  /** How the recipient sees you, as their inbox has it now. */
  const [senderName, setSenderName] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<OutgoingTap[]>(() =>
    loadOutbox(pairing.credentialId)
  );
  /** The style each tap sent from this page asked for, by tap id. */
  const [requested, setRequested] = useState<Record<string, TapTheme>>({});
  const outboxRef = useRef(outbox);
  const revokedRef = useRef(onRevoked);
  useEffect(() => {
    revokedRef.current = onRevoked;
  });

  const updateOutbox = useCallback(
    (update: (current: OutgoingTap[]) => OutgoingTap[]) => {
      const next = update(outboxRef.current);
      outboxRef.current = next;
      saveOutbox(pairing.credentialId, next);
      setOutbox(next);
    },
    [pairing.credentialId]
  );

  const deliver = useCallback(
    async (item: OutgoingTap) => {
      try {
        const tap = await client.sendTap(
          sendRequest(item, loadPatronKey(localStorage))
        );
        updateOutbox((current) =>
          current.filter((o) => o.requestId !== item.requestId)
        );
        setTaps((current) => mergeTap(current, tap));
        const asked = item.theme;
        if (asked) {
          setRequested((current) => ({ ...current, [tap.id]: asked }));
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === "unauthorized") {
          revokedRef.current();
          return;
        }
        // A 402 is never retried automatically: isRetryable is false for it.
        const failed = !isRetryable(error);
        const paused =
          error instanceof ApiError && error.code === "payment_required";
        updateOutbox((current) =>
          current.map((o) =>
            o.requestId === item.requestId
              ? {
                  ...o,
                  failed,
                  paused,
                  error:
                    failed && error instanceof ApiError
                      ? error.message
                      : undefined,
                }
              : o
          )
        );
      }
    },
    [client, updateOutbox]
  );

  const resync = useCallback(async () => {
    try {
      const snapshot = await client.me();
      setTaps((current) => mergeSnapshot(current, snapshot.taps));
      if (snapshot.kind === "sender") {
        setSenderColor(snapshot.senderColor);
        setSenderName(snapshot.senderName);
      }
      setLoaded(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") {
        revokedRef.current();
      }
      return;
    }
    for (const item of outboxRef.current.filter((o) => !o.failed)) {
      deliver(item);
    }
  }, [client, deliver]);

  useEffect(() => {
    const live = connectLive(client, {
      onTap: (tap) => {
        setTaps((current) => mergeTap(current, tap));
      },
      onTapDeleted: (tapId) => {
        setTaps((current) => current.filter((tap) => tap.id !== tapId));
      },
      onResync: resync,
      onStatus: setStatus,
      onRevoked: () => {
        revokedRef.current();
      },
    });
    const wake = () => {
      if (document.visibilityState === "visible") {
        live.nudge();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      live.close();
    };
  }, [client, resync]);

  const send = useCallback(
    (body: string, theme: TapTheme = "default") => {
      const item: OutgoingTap = {
        requestId: newRequestId(),
        body,
        createdAt: Date.now(),
        failed: false,
        theme,
      };
      updateOutbox((current) => [item, ...current]);
      return deliver(item);
    },
    [deliver, updateOutbox]
  );

  const discard = useCallback(
    (requestId: string) => {
      updateOutbox((current) =>
        current.filter((o) => o.requestId !== requestId)
      );
    },
    [updateOutbox]
  );

  return {
    taps,
    outbox,
    requested,
    status,
    loaded,
    senderColor,
    senderName,
    /** Reloads the snapshot, e.g. after changing how they see you. */
    resync,
    send,
    discard,
  };
};
