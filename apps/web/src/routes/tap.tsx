import {
  BubbleChatIcon,
  Clock01Icon,
  SentIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LiveStatus } from "@shouldertap/client";
import {
  describeResponse,
  fallbackColor,
  MAX_TAP_LENGTH,
  type Tap,
  type TapResponse,
} from "@shouldertap/domain";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Frame } from "@/components/frame";
import { isStandalone } from "@/lib/install";
import {
  clearPairing,
  loadPairing,
  type Pairing,
  savePairing,
} from "@/lib/pairing";
import { duration, relativeTime } from "@/lib/time";
import { type OutgoingTap, useSender } from "@/lib/use-sender";

// The composer only means something on a paired phone. Anyone else gets the
// landing page, which explains how to get an invite; a Home Screen app has no
// landing page to show, so it asks for an invite link.
export const Route = createFileRoute("/tap")({
  beforeLoad: () => {
    const pairing = loadPairing();
    if (!pairing) {
      throw redirect({ to: isStandalone() ? "/join" : "/", replace: true });
    }
    return { pairing };
  },
  component: TapComponent,
});

function TapComponent() {
  const { pairing } = Route.useRouteContext();
  const navigate = useNavigate();
  const unpair = useCallback(() => {
    clearPairing();
    navigate({ to: "/", replace: true });
  }, [navigate]);
  return <Composer onUnpair={unpair} pairing={pairing} />;
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
  const { taps, outbox, status, loaded, senderColor, send, discard } =
    useSender(pairing, handleRevoked);
  const [draft, setDraft] = useState("");
  const [, setTick] = useState(0);
  const color =
    pairing.color ?? senderColor ?? fallbackColor(pairing.credentialId);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Pairings made before colors existed learn theirs from the first snapshot.
  useEffect(() => {
    if (!pairing.color && senderColor) {
      savePairing({ ...pairing, color: senderColor });
    }
  }, [pairing, senderColor]);

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
        `Stop sending taps to ${pairing.recipientName} from this phone?`
      )
    ) {
      onUnpair();
    }
  };

  return (
    <Frame color={color}>
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-balance font-extrabold text-[2.125rem] leading-none tracking-[-0.035em]">
          Tap {pairing.recipientName}
        </h1>
        <StatusLabel status={status} />
      </header>

      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="tap-body">
          Message
        </label>
        <textarea
          className="field min-h-28 resize-none leading-snug"
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
          className="pill pill-frame w-full"
          disabled={!draft.trim()}
          type="submit"
        >
          <HugeiconsIcon className="size-5" icon={SentIcon} />
          Send tap
        </button>
      </form>

      <section aria-labelledby="recent" className="flex flex-col">
        <h2 className="mb-1 font-bold text-sm text-tone" id="recent">
          Recent
        </h2>
        <ul className="flex flex-col divide-y divide-line">
          {outbox.map((item) => (
            <li className="py-4 first:pt-2" key={item.requestId}>
              <OutboxItem item={item} onDiscard={discard} onRetry={send} />
            </li>
          ))}
          {taps.map((tap) => (
            <li className="py-4 first:pt-2" key={tap.id}>
              <TapItem recipientName={pairing.recipientName} tap={tap} />
            </li>
          ))}
        </ul>
        {loaded && taps.length === 0 && outbox.length === 0 ? (
          <p className="pt-2 text-[0.9375rem] text-tone leading-snug">
            Nothing sent yet. Your taps and {pairing.recipientName}'s answers
            show up here.
          </p>
        ) : null}
      </section>

      <footer className="mt-auto pt-2 text-center text-[0.8125rem] text-tone">
        Paired as {pairing.senderName} ·{" "}
        <button
          className="text-ink underline underline-offset-[3px]"
          onClick={unpair}
          type="button"
        >
          Unpair this phone
        </button>{" "}
        ·{" "}
        <a
          className="text-ink underline underline-offset-[3px]"
          href="/support"
        >
          Help
        </a>
      </footer>
    </Frame>
  );
}

function StatusLabel({ status }: { status: LiveStatus }) {
  const label = {
    live: "Live",
    connecting: "Connecting",
    offline: "Reconnecting",
  }[status];
  return (
    <span
      aria-live="polite"
      className="inline-flex shrink-0 items-center gap-[7px] pt-2 font-semibold text-[0.8125rem] text-tone"
    >
      <span
        className={`size-2 rounded-full ${status === "live" ? "bg-live" : "animate-[pulse-soft_1.6s_ease-in-out_infinite] bg-tone"}`}
      />
      {label}
    </span>
  );
}

const STEPS = ["Sent", "On screen", "Answered"] as const;

const segmentClass = (step: number, reached: number) => {
  if (step < reached) {
    return "bg-frame";
  }
  if (step === reached) {
    return "animate-[pulse-soft_1.6s_ease-in-out_infinite] bg-frame";
  }
  return "bg-faint";
};

/** Three segments in the sender's color: where the tap is right now. */
function Track({ reached, note }: { reached: number; note: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="grid grid-cols-3 gap-1">
        {STEPS.map((step, i) => (
          <i
            className={`h-[5px] rounded-full ${segmentClass(i, reached)}`}
            key={step}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="grid grid-cols-3 gap-1 font-semibold text-tone text-xs"
      >
        {STEPS.map((step, i) => (
          <span className={i === reached - 1 ? "text-ink" : ""} key={step}>
            {step}
          </span>
        ))}
      </div>
      <span className="sr-only">{note}</span>
    </div>
  );
}

function OutboxItem({
  item,
  onRetry,
  onDiscard,
}: {
  item: OutgoingTap;
  onRetry: (body: string) => void;
  onDiscard: (requestId: string) => void;
}) {
  return (
    <article className="flex flex-col gap-3">
      <p className="font-bold text-[1.3125rem] leading-tight tracking-[-0.02em]">
        {item.body}
      </p>
      {item.failed ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto font-semibold text-[0.9375rem] text-destructive">
            Couldn't send
          </span>
          <button
            className="pill pill-sm"
            onClick={() => onDiscard(item.requestId)}
            type="button"
          >
            Discard
          </button>
          <button
            className="pill pill-sm pill-frame"
            onClick={() => {
              onDiscard(item.requestId);
              onRetry(item.body);
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <Track note="Sending" reached={0} />
      )}
    </article>
  );
}

const RESPONSE_ICON = {
  on_it: Tick02Icon,
  in_10: Clock01Icon,
  text: BubbleChatIcon,
} as const;

function TapItem({ tap, recipientName }: { tap: Tap; recipientName: string }) {
  const answered =
    tap.state === "acknowledged" && tap.response && tap.acknowledgedAt;
  return (
    <article className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-bold text-[1.3125rem] leading-tight tracking-[-0.02em]">
          {tap.body}
        </p>
        <time
          className="shrink-0 text-[0.8125rem] text-tone tabular-nums"
          dateTime={new Date(tap.createdAt).toISOString()}
        >
          {relativeTime(tap.createdAt)}
        </time>
      </div>
      {answered ? (
        <Answer
          acknowledgedAt={tap.acknowledgedAt as number}
          by={tap.acknowledgedBy}
          createdAt={tap.createdAt}
          response={tap.response as TapResponse}
        />
      ) : (
        <Track
          note={
            tap.displayedAt
              ? `On ${recipientName}'s screen now`
              : `Waiting for ${recipientName}'s Mac`
          }
          reached={tap.displayedAt ? 2 : 1}
        />
      )}
    </article>
  );
}

function Answer({
  response,
  createdAt,
  acknowledgedAt,
  by,
}: {
  response: TapResponse;
  createdAt: number;
  acknowledgedAt: number;
  by: string | null;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-faint px-3.5 py-3">
      <HugeiconsIcon
        className="size-5 shrink-0"
        icon={RESPONSE_ICON[response.kind]}
      />
      <b className="min-w-0 break-words font-bold text-[1.0625rem] leading-snug">
        {describeResponse(response)}
      </b>
      <span className="ml-auto shrink-0 text-right text-[0.8125rem] text-tone tabular-nums leading-tight">
        {duration(createdAt, acknowledgedAt)} later
        {by ? (
          <>
            <br />
            on {by}
          </>
        ) : null}
      </span>
    </div>
  );
}
