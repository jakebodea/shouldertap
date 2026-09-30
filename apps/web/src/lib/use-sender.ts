import {
  ApiError,
  connectLive,
  isRetryable,
  type LiveStatus,
  mergeSnapshot,
  mergeTap,
} from "@shouldertap/client";
import type { Tap } from "@shouldertap/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import { newRequestId } from "./ids";
import type { Pairing } from "./pairing";

export interface OutgoingTap {
  readonly body: string;
  readonly createdAt: number;
  readonly failed: boolean;
  readonly requestId: string;
}

const OUTBOX_KEY = "shouldertap.outbox.v1";

const loadOutbox = (): OutgoingTap[] => {
  try {
    return JSON.parse(
      localStorage.getItem(OUTBOX_KEY) ?? "[]"
    ) as OutgoingTap[];
  } catch {
    return [];
  }
};

const saveOutbox = (outbox: readonly OutgoingTap[]) => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch {
    // Best effort.
  }
};

/**
 * Sender state: the authoritative snapshot, live updates, and an outbox of
 * sends that haven't been accepted yet. Each send keeps its request id, so
 * a retry after a dropped connection can't create a duplicate tap.
 */
export const useSender = (pairing: Pairing, onRevoked: () => void) => {
  const client = useMemo(() => api.withToken(pairing.token), [pairing.token]);
  const [taps, setTaps] = useState<Tap[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [loaded, setLoaded] = useState(false);
  const [outbox, setOutbox] = useState<OutgoingTap[]>(loadOutbox);
  const outboxRef = useRef(outbox);
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;

  const updateOutbox = useCallback(
    (update: (current: OutgoingTap[]) => OutgoingTap[]) => {
      const next = update(outboxRef.current);
      outboxRef.current = next;
      saveOutbox(next);
      setOutbox(next);
    },
    []
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
        updateOutbox((current) =>
          current.map((o) =>
            o.requestId === item.requestId
              ? { ...o, failed: !isRetryable(error) }
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

  return { taps, outbox, status, loaded, send, discard };
};
