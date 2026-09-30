import {
  ApiClient,
  ApiError,
  connectLive,
  isRetryable,
  type LiveConnection,
  type LiveStatus,
  mergeSnapshot,
  mergeTap,
} from "@shouldertap/client";
import type { Credential, Tap, TapResponse } from "@shouldertap/domain";

import { endpoints } from "./config";
import { native, onNativeEvent } from "./native";

export type Phase = "loading" | "setup" | "ready";

export interface OverlayTap {
  readonly body: string;
  readonly createdAt: number;
  readonly id: string;
  /** Other taps waiting behind this one. */
  readonly queued: number;
  readonly senderName: string;
}

export interface State {
  readonly credentialId: string | null;
  readonly credentials: readonly Credential[];
  /** Responses given on this Mac that the server hasn't confirmed yet. */
  readonly pendingAcks: Readonly<Record<string, TapResponse>>;
  readonly phase: Phase;
  readonly recipientName: string;
  readonly status: LiveStatus;
  readonly taps: readonly Tap[];
}

const CREDENTIAL_KEY = "credential";
const PENDING_ACKS_KEY = "pendingAcks";
const ACK_RETRY_MS = 10_000;

const initial: State = {
  phase: "loading",
  recipientName: "",
  credentialId: null,
  taps: [],
  credentials: [],
  status: "connecting",
  pendingAcks: {},
};

/**
 * All Mac client behavior in one place: the device credential, the live
 * connection, which tap the overlay shows, and acknowledgements that must
 * survive being offline. Native code only draws what this decides.
 */
class Store {
  private state: State = initial;
  private readonly listeners = new Set<() => void>();
  private api = new ApiClient({ baseUrl: endpoints.serverUrl });
  private live: LiveConnection | null = null;
  private shownOverlayKey: string | null = null;
  private readonly reportedDisplayed = new Set<string>();
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private startup: Promise<void> | null = null;

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
    this.reconcileOverlay();
  }

  start() {
    this.startup ??= this.boot();
    return this.startup;
  }

  private async boot() {
    onNativeEvent("wake", () => this.live?.nudge());

    const savedAcks = await native.getItem(PENDING_ACKS_KEY).catch(() => null);
    const pendingAcks = savedAcks
      ? (JSON.parse(savedAcks) as Record<string, TapResponse>)
      : {};
    const token = await native.getSecret(CREDENTIAL_KEY).catch(() => null);
    if (!token) {
      this.set({ phase: "setup", pendingAcks });
      native.openPopover();
      return;
    }
    this.set({ pendingAcks });
    this.connect(token);
  }

  // Setup

  async createInbox(recipientName: string) {
    const grant = await this.api.createInbox({
      recipientName,
      deviceName: await this.deviceName(),
    });
    await native.setSecret(CREDENTIAL_KEY, grant.token);
    this.connect(grant.token);
  }

  async joinWithCode(code: string) {
    const grant = await this.api.redeemInvite({
      code: code.trim(),
      name: await this.deviceName(),
    });
    if (grant.kind !== "device") {
      throw new Error(
        "That's a sender invite. Open it on the phone that will send taps."
      );
    }
    await native.setSecret(CREDENTIAL_KEY, grant.token);
    this.connect(grant.token);
  }

  private async deviceName() {
    const name = await native.deviceName().catch(() => "Mac");
    return name.slice(0, 40).trim() || "Mac";
  }

  // Connection

  private connect(token: string) {
    this.live?.close();
    this.api = this.api.withToken(token);
    this.set({ phase: "ready", status: "connecting" });
    this.live = connectLive(this.api, {
      onTap: (tap) => this.set({ taps: mergeTap(this.state.taps, tap) }),
      onResync: () => {
        this.resync();
      },
      onStatus: (status) => this.set({ status }),
      onRevoked: () => {
        this.forget();
      },
    });
  }

  private async resync() {
    try {
      const snapshot = await this.api.me();
      if (snapshot.kind !== "device") {
        return;
      }
      this.set({
        recipientName: snapshot.recipientName,
        credentialId: snapshot.credentialId,
        credentials: snapshot.credentials,
        taps: mergeSnapshot(this.state.taps, snapshot.taps),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") {
        this.forget();
        return;
      }
    }
    this.flushAcks();
  }

  private async forget() {
    this.live?.close();
    this.live = null;
    await native.deleteSecret(CREDENTIAL_KEY).catch(() => undefined);
    this.api = this.api.withToken(null);
    this.savePendingAcks({});
    this.set({ ...initial, phase: "setup", status: "offline" });
  }

  // Responding

  respond(tapId: string, response: TapResponse) {
    // Dismiss locally right away; the sender sees it once the server commits.
    this.savePendingAcks({ ...this.state.pendingAcks, [tapId]: response });
    this.flushAcks();
  }

  private savePendingAcks(pendingAcks: Record<string, TapResponse>) {
    native.setItem(
      PENDING_ACKS_KEY,
      Object.keys(pendingAcks).length > 0 ? JSON.stringify(pendingAcks) : null
    );
    this.set({ pendingAcks });
  }

  private async flushAcks() {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (!this.api.token) {
      return;
    }
    // Acknowledgements are idempotent server-side, so overlapping flushes are safe.
    const outcomes = await Promise.all(
      Object.entries(this.state.pendingAcks).map(async ([tapId, response]) => {
        try {
          const tap = await this.api.acknowledge(tapId, { response });
          this.dropPendingAck(tapId);
          this.set({ taps: mergeTap(this.state.taps, tap) });
          return "done" as const;
        } catch (error) {
          if (isRetryable(error)) {
            return "retry" as const;
          }
          this.dropPendingAck(tapId);
          return "dropped" as const;
        }
      })
    );
    if (outcomes.includes("retry")) {
      this.ackTimer = setTimeout(() => this.flushAcks(), ACK_RETRY_MS);
    }
  }

  private dropPendingAck(tapId: string) {
    const { [tapId]: _dropped, ...rest } = this.state.pendingAcks;
    this.savePendingAcks(rest);
  }

  // Overlay

  private activeTap(): OverlayTap | null {
    const waiting = this.state.taps
      .filter(
        (tap) => tap.state === "pending" && !this.state.pendingAcks[tap.id]
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const [first] = waiting;
    return first
      ? {
          id: first.id,
          body: first.body,
          senderName: first.senderName,
          createdAt: first.createdAt,
          queued: waiting.length - 1,
        }
      : null;
  }

  private reconcileOverlay() {
    if (this.state.phase !== "ready") {
      if (this.shownOverlayKey) {
        this.shownOverlayKey = null;
        native.hideOverlay();
      }
      return;
    }
    const active = this.activeTap();
    native.setPending(active !== null);
    if (!active) {
      if (this.shownOverlayKey) {
        this.shownOverlayKey = null;
        native.hideOverlay();
      }
      return;
    }
    const key = `${active.id}:${active.queued}`;
    if (key === this.shownOverlayKey) {
      return;
    }
    this.shownOverlayKey = key;
    native.showOverlay(active);
    this.reportDisplayed(active.id);
  }

  private async reportDisplayed(tapId: string) {
    const tap = this.state.taps.find((candidate) => candidate.id === tapId);
    if (!tap || tap.displayedAt !== null || this.reportedDisplayed.has(tapId)) {
      return;
    }
    this.reportedDisplayed.add(tapId);
    try {
      const updated = await this.api.markDisplayed(tapId);
      this.set({ taps: mergeTap(this.state.taps, updated) });
    } catch {
      this.reportedDisplayed.delete(tapId);
    }
  }

  // Pairing management

  async createSenderInvite() {
    const invite = await this.api.createInvite("sender");
    const url = `${endpoints.webUrl}/join#${invite.code}`;
    const qr = await native.qrCode(url);
    return { url, qr, expiresAt: invite.expiresAt };
  }

  async createDeviceCode() {
    const invite = await this.api.createInvite("device");
    return { code: invite.code, expiresAt: invite.expiresAt };
  }

  async revoke(credentialId: string) {
    if (credentialId === this.state.credentialId) {
      await this.api.revoke(credentialId).catch(() => undefined);
      await this.forget();
      return;
    }
    await this.api.revoke(credentialId);
    await this.resync();
  }
}

export const store = new Store();
