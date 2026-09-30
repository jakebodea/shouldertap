import type { LiveStatus } from "@shouldertap/client";
import {
  describeResponse,
  MAX_TAP_LENGTH,
  quickTaps,
  type Tap,
} from "@shouldertap/domain";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { clearPairing, loadPairing, type Pairing } from "@/lib/pairing";
import { duration, relativeTime } from "@/lib/time";
import { type OutgoingTap, useSender } from "@/lib/use-sender";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const [pairing, setPairing] = useState<Pairing | null>(loadPairing);
  const unpair = useCallback(() => {
    clearPairing();
    setPairing(null);
  }, []);
  return pairing ? (
    <Composer onUnpair={unpair} pairing={pairing} />
  ) : (
    <Welcome />
  );
}

function Welcome() {
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <img alt="" className="size-14" height={56} src="/icon.svg" width={56} />
      <h1 className="font-semibold text-3xl tracking-tight">Shouldertap</h1>
      <p className="text-lg text-muted-foreground leading-relaxed">
        Get someone's attention when they're deep in focus. Your message takes
        over their Mac screens until they answer, and you see their reply here
        right away.
      </p>
      <div className="rounded-2xl border bg-card p-5 text-sm leading-relaxed">
        To start, ask the person you want to reach to open{" "}
        <strong>Shouldertap</strong> in their Mac's menu bar and share an invite
        link with you.
      </div>
    </main>
  );
}

function Composer({
  pairing,
  onUnpair,
}: {
  pairing: Pairing;
  onUnpair: () => void;
}) {
  const handleRevoked = useCallback(() => {
    toast.error(`${pairing.recipientName} removed this pairing`);
    onUnpair();
  }, [onUnpair, pairing.recipientName]);
  const { taps, outbox, status, loaded, send, discard } = useSender(
    pairing,
    handleRevoked
  );
  const [draft, setDraft] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  const submit = (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    setDraft("");
    send(trimmed);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(draft);
  };

  const unpair = () => {
    if (
      // biome-ignore lint/suspicious/noAlert: a native confirm is right for this rare action
      window.confirm(
        `Stop sending taps to ${pairing.recipientName} from this device?`
      )
    ) {
      onUnpair();
    }
  };

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-6 px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-muted-foreground text-sm">Shouldertap</p>
          <h1 className="font-semibold text-2xl tracking-tight">
            Tap {pairing.recipientName}
          </h1>
        </div>
        <StatusPill status={status} />
      </header>

      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <div className="flex flex-wrap gap-2">
          {quickTaps.map((text) => (
            <button
              className="rounded-full border bg-card px-3.5 py-2 text-sm transition active:scale-95"
              key={text}
              onClick={() => submit(text)}
              type="button"
            >
              {text}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="tap-body">
          Message
        </label>
        <textarea
          className="min-h-28 w-full resize-none rounded-2xl border bg-card p-4 text-base outline-none focus:ring-2 focus:ring-tap/40"
          id="tap-body"
          maxLength={MAX_TAP_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              submit(draft);
            }
          }}
          placeholder={`What does ${pairing.recipientName} need to know?`}
          value={draft}
        />
        <button
          className="h-12 rounded-2xl bg-tap font-semibold text-base text-tap-foreground shadow-sm transition active:scale-[0.98] disabled:opacity-40"
          disabled={!draft.trim()}
          type="submit"
        >
          Send tap
        </button>
      </form>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-muted-foreground text-sm">Recent</h2>
        {outbox.map((item) => (
          <OutboxCard
            item={item}
            key={item.requestId}
            onDiscard={discard}
            onRetry={send}
          />
        ))}
        {taps.map((tap) => (
          <TapCard
            key={tap.id}
            recipientName={pairing.recipientName}
            tap={tap}
          />
        ))}
        {loaded && taps.length === 0 && outbox.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-5 text-center text-muted-foreground text-sm">
            Nothing sent yet. Your taps and {pairing.recipientName}'s replies
            show up here.
          </p>
        ) : null}
      </section>

      <footer className="mt-auto pt-4 text-center text-muted-foreground text-xs">
        Paired as {pairing.senderName} ·{" "}
        <button
          className="underline underline-offset-2"
          onClick={unpair}
          type="button"
        >
          Unpair this device
        </button>
      </footer>
    </main>
  );
}

function StatusPill({ status }: { status: LiveStatus }) {
  const label = {
    live: "Live",
    connecting: "Connecting…",
    offline: "Reconnecting…",
  }[status];
  const dot = {
    live: "bg-emerald-500",
    connecting: "bg-amber-400",
    offline: "bg-zinc-400",
  }[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs">
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function OutboxCard({
  item,
  onRetry,
  onDiscard,
}: {
  item: OutgoingTap;
  onRetry: (body: string) => void;
  onDiscard: (requestId: string) => void;
}) {
  return (
    <article className="rounded-2xl border bg-card p-4">
      <p className="text-base leading-snug">{item.body}</p>
      {item.failed ? (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span className="text-destructive">Couldn't send</span>
          <button
            className="font-medium underline underline-offset-2"
            onClick={() => {
              onDiscard(item.requestId);
              onRetry(item.body);
            }}
            type="button"
          >
            Try again
          </button>
          <button
            className="text-muted-foreground underline underline-offset-2"
            onClick={() => onDiscard(item.requestId)}
            type="button"
          >
            Discard
          </button>
        </div>
      ) : (
        <p className="mt-2 text-muted-foreground text-sm">Sending…</p>
      )}
    </article>
  );
}

function TapCard({ tap, recipientName }: { tap: Tap; recipientName: string }) {
  const acknowledged =
    tap.state === "acknowledged" && tap.response && tap.acknowledgedAt;
  return (
    <article
      className={`rounded-2xl border p-4 transition ${acknowledged ? "bg-card" : "border-tap/40 bg-tap/5"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-base leading-snug">{tap.body}</p>
        <time className="shrink-0 text-muted-foreground text-xs">
          {relativeTime(tap.createdAt)}
        </time>
      </div>
      {acknowledged ? (
        <div className="mt-3 rounded-xl bg-muted px-3 py-2.5">
          <p className="font-medium text-base">
            {describeResponse(tap.response)}
          </p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {recipientName} replied{" "}
            {duration(tap.createdAt, tap.acknowledgedAt)} later
            {tap.acknowledgedBy ? ` on ${tap.acknowledgedBy}` : ""}
          </p>
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-2 text-sm">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-tap opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-tap" />
          </span>
          {tap.displayedAt
            ? `On ${recipientName}'s screen now`
            : `Delivered · waiting for ${recipientName}'s Mac`}
        </p>
      )}
    </article>
  );
}
