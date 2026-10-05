import {
  ApiError,
  connectLive,
  isRetryable,
  type LiveStatus,
  mergeSnapshot,
  mergeTap,
} from "@shouldertap/client";
import type { PersonColor, Tap } from "@shouldertap/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import { newRequestId } from "./ids";
import { outboxKey, type Pairing } from "./pairing";

export interface OutgoingTap {
  readonly body: string;
  readonly createdAt: number;
  /** Why the server refused it, e.g. the hourly limit. */
  readonly error?: string;
  readonly failed: boolean;
  /** Refused because the recipient's trial ended; retrying won't help yet. */
  readonly paused?: boolean;
  readonly requestId: string;
}

const loadOutbox = (credentialId: string): OutgoingTap[] => {
  try {
    return JSON.parse(
      localStorage.getItem(outboxKey(credentialId)) ?? "[]"
    ) as OutgoingTap[];
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
  const [outbox, setOutbox] = useState<OutgoingTap[]>(() =>
    loadOutbox(pairing.credentialId)
  );
  const outboxRef = useRef(outbox);
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;

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
        const tap = await client.sendTap({
          requestId: item.requestId,
          body: item.body,
        });
        updateOutbox((current) =>
          current.filter((o) => o.requestId !== item.requestId)
        );
        setTaps((current) => mergeTap(current, tap));
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
      onTap: (tap) => setTaps((current) => mergeTap(current, tap)),
      onTapDeleted: (tapId) =>
        setTaps((current) => current.filter((tap) => tap.id !== tapId)),
      onResync: resync,
      onStatus: setStatus,
      onRevoked: () => revokedRef.current(),
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
    (body: string) => {
      const item: OutgoingTap = {
        requestId: newRequestId(),
        body,
        createdAt: Date.now(),
        failed: false,
      };
      updateOutbox((current) => [item, ...current]);
      return deliver(item);
    },
    [deliver, updateOutbox]
  );

  const discard = useCallback(
    (requestId: string) =>
      updateOutbox((current) =>
        current.filter((o) => o.requestId !== requestId)
      ),
    [updateOutbox]
  );

  return { taps, outbox, status, loaded, senderColor, send, discard };
};
