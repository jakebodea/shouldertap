import { ServerEvent, type Tap } from "@shouldertap/domain";
import * as Schema from "effect/Schema";

import { type ApiClient, ApiError } from "./api";

export type LiveStatus = "connecting" | "live" | "offline";

export interface LiveHandlers {
  /**
   * Refetch the authoritative snapshot. Called after every (re)connect, and
   * whenever the server says pairings changed, so a missed event is never lost.
   */
  readonly onResync: () => void;
  /** The credential was revoked or is no longer valid. The connection stops. */
  readonly onRevoked?: () => void;
  readonly onStatus?: (status: LiveStatus) => void;
  /** A tap changed. Apply with `mergeTap`; the server's sequence orders updates. */
  readonly onTap: (tap: Tap) => void;
  /** A tap was deleted. Without this handler, the snapshot is refetched. */
  readonly onTapDeleted?: (tapId: string) => void;
}

export interface LiveConnection {
  readonly close: () => void;
  /** Reconnect now (e.g. after wake or the network coming back). */
  readonly nudge: () => void;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const PING_INTERVAL_MS = 25_000;
const decodeEvent = Schema.decodeUnknownOption(ServerEvent);

/**
 * Keeps one authorized WebSocket open for server events. Commands still go
 * over HTTPS; this only listens. Each connect exchanges the long-lived
 * credential for a one-time ticket so the credential never appears in a URL.
 */
export const connectLive = (
  api: ApiClient,
  handlers: LiveHandlers
): LiveConnection => {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const setStatus = (status: LiveStatus) => handlers.onStatus?.(status);

  const clearTimers = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleRetry = () => {
    if (closed) {
      return;
    }
    setStatus("offline");
    const delay =
      BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  const stop = () => {
    closed = true;
    clearTimers();
    socket?.close(1000, "closing");
    socket = null;
  };

  async function open() {
    clearTimers();
    if (closed) {
      return;
    }
    setStatus("connecting");
    let ticket: string;
    try {
      ({ ticket } = await api.connectTicket());
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") {
        stop();
        handlers.onRevoked?.();
        return;
      }
      scheduleRetry();
      return;
    }
    if (closed) {
      return;
    }
    const next = new WebSocket(
      `${api.socketUrl}?ticket=${encodeURIComponent(ticket)}`
    );
    socket = next;

    next.onopen = () => {
      attempt = 0;
      setStatus("live");
      handlers.onResync();
      pingTimer = setInterval(() => {
        if (next.readyState === WebSocket.OPEN) {
          next.send("ping");
        }
      }, PING_INTERVAL_MS);
    };

    next.onmessage = (message) => {
      if (typeof message.data !== "string" || message.data === "pong") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      const event = decodeEvent(parsed);
      if (event._tag === "None") {
        // Unknown or newer event version: resync from the snapshot instead.
        handlers.onResync();
        return;
      }
      switch (event.value.type) {
        case "tap":
          handlers.onTap(event.value.tap);
          break;
        case "deleted":
          if (handlers.onTapDeleted) {
            handlers.onTapDeleted(event.value.tapId);
          } else {
            handlers.onResync();
          }
          break;
        case "credentials":
          handlers.onResync();
          break;
        case "revoked":
          stop();
          handlers.onRevoked?.();
          break;
        default:
          break;
      }
    };

    next.onclose = () => {
      if (socket === next) {
        socket = null;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        scheduleRetry();
      }
    };

    next.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  open();

  return {
    nudge: () => {
      if (closed) {
        return;
      }
      attempt = 0;
      if (socket && socket.readyState === WebSocket.OPEN) {
        handlers.onResync();
        return;
      }
      const stale = socket;
      socket = null;
      stale?.close();
      open();
    },
    close: stop,
  };
};

/** Insert or replace a tap unless the incoming copy is older. Newest first. */
export const mergeTap = (taps: readonly Tap[], incoming: Tap): Tap[] => {
  const existing = taps.find((tap) => tap.id === incoming.id);
  if (existing && existing.sequence > incoming.sequence) {
    return [...taps];
  }
  return [incoming, ...taps.filter((tap) => tap.id !== incoming.id)].sort(
    (a, b) => b.createdAt - a.createdAt
  );
};

/** Replace local state with a snapshot, keeping any newer local copies. */
export const mergeSnapshot = (
  local: readonly Tap[],
  snapshot: readonly Tap[]
): Tap[] =>
  local.reduce(
    (acc, tap) => {
      const fromServer = acc.find((candidate) => candidate.id === tap.id);
      return fromServer && fromServer.sequence < tap.sequence
        ? mergeTap(acc, tap)
        : acc;
    },
    [...snapshot].sort((a, b) => b.createdAt - a.createdAt)
  );
