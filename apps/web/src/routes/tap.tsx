import {
  BubbleChatIcon,
  Clock01Icon,
  SentIcon,
  Tick02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LiveStatus } from "@shouldertap/client";
import {
  describeResponse,
  fallbackColor,
  MAX_TAP_LENGTH,
} from "@shouldertap/domain";
import type { Tap, TapResponse } from "@shouldertap/domain";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { Frame } from "@/components/frame";
import { revokePairing } from "@/lib/api";
import { isStandalone } from "@/lib/install";
import {
  loadPairing,
  loadPairings,
  removePairing,
  selectPairing,
  updatePairing,
} from "@/lib/pairing";
import type { Pairing } from "@/lib/pairing";
import { duration, relativeTime } from "@/lib/time";
import { useSender } from "@/lib/use-sender";
import type { OutgoingTap } from "@/lib/use-sender";

const TapComponent = () => {
  const navigate = useNavigate();
  const [pairing, setPairing] = useState(loadPairing);
  const select = useCallback((credentialId: string) => {
    selectPairing(credentialId);
    setPairing(loadPairing());
  }, []);
  const unpair = useCallback(
    (credentialId: string) => {
      removePairing(credentialId);
      const next = loadPairing();
      if (next) {
        setPairing(next);
      } else {
        navigate({ to: "/", replace: true });
      }
    },
    [navigate]
  );
  if (!pairing) {
    return null;
  }
  // Keyed so each person gets their own outbox, socket and draft.
  return (
    <Composer
      key={pairing.credentialId}
      onSelect={select}
      onUnpair={() => {
        unpair(pairing.credentialId);
      }}
      pairing={pairing}
    />
  );
};

const Composer = ({
  pairing,
  onSelect,
  onUnpair,
}: {
  pairing: Pairing;
  onSelect: (credentialId: string) => void;
  onUnpair: () => void;
}) => {
  const handleRevoked = useCallback(() => {
    // Unpairing here revokes too; that's not the recipient removing us.
    const stillPaired = loadPairings().some(
      (p) => p.credentialId === pairing.credentialId
    );
    if (!stillPaired) {
      return;
    }
    toast.error(`${pairing.recipientName} removed this pairing`);
    onUnpair();
  }, [onUnpair, pairing.credentialId, pairing.recipientName]);
  const { taps, outbox, status, loaded, senderColor, send, discard } =
    useSender(pairing, handleRevoked);
  const [draft, setDraft] = useState("");
  const [, setTick] = useState(0);
  const color =
    pairing.color ?? senderColor ?? fallbackColor(pairing.credentialId);
  // The recipient's trial ended: say so above the composer, once.
  const paused = outbox.find((item) => item.paused);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // Pairings made before colors existed learn theirs from the first snapshot.
  useEffect(() => {
    if (!pairing.color && senderColor) {
      updatePairing({ ...pairing, color: senderColor });
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
      // oxlint-disable-next-line no-alert -- a native confirm is right for this rare action
      window.confirm(
        `Stop sending taps to ${pairing.recipientName} from this phone?`
      )
    ) {
      onUnpair();
      revokePairing(pairing);
    }
  };

  return (
    <Frame color={color}>
      <header className="flex items-start justify-between gap-4">
        <RecipientPicker onSelect={onSelect} pairing={pairing} />
        <StatusLabel status={status} />
      </header>

      {paused ? (
        <output className="bg-faint block rounded-[18px] px-4 py-3 text-[0.9375rem] leading-snug font-semibold">
          {paused.error}
        </output>
      ) : null}

      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="tap-body">
          Message
        </label>
        <textarea
          className="field min-h-28 resize-none leading-snug"
          id="tap-body"
          maxLength={MAX_TAP_LENGTH}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
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
        <h2 className="text-tone mb-1 text-sm font-bold" id="recent">
          Recent
        </h2>
        <ul className="divide-line flex flex-col divide-y">
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
          <p className="text-tone pt-2 text-[0.9375rem] leading-snug">
            Nothing sent yet. Your taps and {pairing.recipientName}&apos;s
            answers show up here.
          </p>
        ) : null}
      </section>

      <footer className="text-tone mt-auto pt-2 text-center text-[0.8125rem]">
        Paired as {pairing.senderName} ·{" "}
        <button
          className="text-ink underline underline-offset-[3px]"
          onClick={unpair}
          type="button"
        >
          Unpair
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
};

const ADD_SOMEONE = "add";

/**
 * The heading doubles as a native picker: everyone this phone can tap, plus
 * a way to pair with someone new.
 */
const RecipientPicker = ({
  pairing,
  onSelect,
}: {
  pairing: Pairing;
  onSelect: (credentialId: string) => void;
}) => {
  const navigate = useNavigate();
  const pairings = useMemo(() => loadPairings(), []);
  return (
    <div className="relative min-w-0">
      <h1 className="text-[2.125rem] leading-none font-extrabold tracking-[-0.035em] text-balance">
        Tap {pairing.recipientName}
        <HugeiconsIcon
          aria-hidden="true"
          className="text-tone ml-1.5 inline size-[0.7em] align-[0.02em]"
          icon={UnfoldMoreIcon}
          strokeWidth={2.5}
        />
      </h1>
      <select
        aria-label="Who to tap"
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
        onChange={(event) => {
          const { value } = event.target;
          if (value === ADD_SOMEONE) {
            navigate({ to: "/join" });
          } else {
            onSelect(value);
          }
        }}
        value={pairing.credentialId}
      >
        {pairings.map((p) => (
          <option key={p.credentialId} value={p.credentialId}>
            {p.recipientName}
          </option>
        ))}
        <option value={ADD_SOMEONE}>Add someone…</option>
      </select>
    </div>
  );
};

const StatusLabel = ({ status }: { status: LiveStatus }) => {
  const label = {
    live: "Live",
    connecting: "Connecting",
    offline: "Reconnecting",
  }[status];
  return (
    <span
      aria-live="polite"
      className="text-tone inline-flex shrink-0 items-center gap-[7px] pt-2 text-[0.8125rem] font-semibold"
    >
      <span
        className={`size-2 rounded-full ${status === "live" ? "bg-live" : "bg-tone animate-[pulse-soft_1.6s_ease-in-out_infinite]"}`}
      />
      {label}
    </span>
  );
};

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
const Track = ({ reached, note }: { reached: number; note: string }) => (
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
      className="text-tone grid grid-cols-3 gap-1 text-xs font-semibold"
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

const OutboxItem = ({
  item,
  onRetry,
  onDiscard,
}: {
  item: OutgoingTap;
  onRetry: (body: string) => void;
  onDiscard: (requestId: string) => void;
}) => (
  <article className="flex flex-col gap-3">
    <p className="text-[1.3125rem] leading-tight font-bold tracking-[-0.02em]">
      {item.body}
    </p>
    {item.failed ? (
      <div className="flex flex-wrap items-center gap-2">
        {item.paused ? (
          <span className="text-tone mr-auto text-[0.9375rem] leading-snug font-semibold">
            Not sent: taps are paused
          </span>
        ) : (
          <span className="text-destructive mr-auto text-[0.9375rem] leading-snug font-semibold">
            {item.error ?? "Couldn't send"}
          </span>
        )}
        <button
          className="pill pill-sm"
          onClick={() => {
            onDiscard(item.requestId);
          }}
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

const RESPONSE_ICON = {
  on_it: Tick02Icon,
  in_10: Clock01Icon,
  text: BubbleChatIcon,
} as const;

const TapItem = ({
  tap,
  recipientName,
}: {
  tap: Tap;
  recipientName: string;
}) => {
  const answered =
    tap.state === "acknowledged" && tap.response && tap.acknowledgedAt;
  return (
    <article className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[1.3125rem] leading-tight font-bold tracking-[-0.02em]">
          {tap.body}
        </p>
        <time
          className="text-tone shrink-0 text-[0.8125rem] tabular-nums"
          dateTime={new Date(tap.createdAt).toISOString()}
        >
          {relativeTime(tap.createdAt)}
        </time>
      </div>
      {answered ? (
        <Answer
          acknowledgedAt={tap.acknowledgedAt}
          by={tap.acknowledgedBy}
          createdAt={tap.createdAt}
          response={tap.response}
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
};

const Answer = ({
  response,
  createdAt,
  acknowledgedAt,
  by,
}: {
  response: TapResponse;
  createdAt: number;
  acknowledgedAt: number;
  by: string | null;
}) => (
  <div className="bg-faint flex items-center gap-2.5 rounded-2xl px-3.5 py-3">
    <HugeiconsIcon
      className="size-5 shrink-0"
      icon={RESPONSE_ICON[response.kind]}
    />
    <b className="min-w-0 text-[1.0625rem] leading-snug font-bold break-words">
      {describeResponse(response)}
    </b>
    <span className="text-tone ml-auto shrink-0 text-right text-[0.8125rem] leading-tight tabular-nums">
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

// The composer only means something on a paired phone. Anyone else gets the
// landing page, which explains how to get an invite; a Home Screen app has no
// landing page to show, so it asks for an invite link.
export const Route = createFileRoute("/tap")({
  beforeLoad: () => {
    if (!loadPairing()) {
      throw redirect({ to: isStandalone() ? "/join" : "/", replace: true });
    }
  },
  component: TapComponent,
});
