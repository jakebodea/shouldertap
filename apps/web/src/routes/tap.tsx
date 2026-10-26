import {
  ArrowRight01Icon,
  BubbleChatIcon,
  Clock01Icon,
  Link01Icon,
  SentIcon,
  Tick02Icon,
  UnfoldMoreIcon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LiveStatus } from "@shouldertap/client";
import {
  describeResponse,
  fallbackColor,
  MAX_TAP_LENGTH,
} from "@shouldertap/domain";
import type {
  PersonColor,
  Tap,
  TapResponse,
  TapTheme,
} from "@shouldertap/domain";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import { toast } from "sonner";

import { Frame } from "@/components/frame";
import { InvitePanel } from "@/components/invite-panel";
import { Mark } from "@/components/mark";
import { MiniTap } from "@/components/mini-tap";
import { SendProfileEditor } from "@/components/seen-as";
import { StepHeading } from "@/components/sign-in";
import { TapPreview } from "@/components/tap-preview/tap-preview";
import type { PreviewTap } from "@/components/tap-preview/themes";
import {
  account,
  isSignedOutError,
  loadSession,
  needsSignIn,
  syncThisBrowser,
} from "@/lib/account";
import { removePerson } from "@/lib/api";
import {
  inboxOf,
  loadPairing,
  loadPairings,
  removePairing,
  selectPairing,
  updatePairing,
} from "@/lib/pairing";
import type { Pairing } from "@/lib/pairing";
import {
  downgradeNote,
  loadDraft,
  loadStyle,
  saveDraft,
} from "@/lib/sender-style";
import { PATRON_THEMES, THEME_NAMES } from "@/lib/theme-names";
import { duration, relativeTime } from "@/lib/time";
import { useSender } from "@/lib/use-sender";
import type { OutgoingTap } from "@/lib/use-sender";

const TapComponent = () => {
  const navigate = useNavigate();
  const { session } = Route.useRouteContext();
  const me = session.kind === "signed-in" ? session.me : null;
  const [pairings, setPairings] = useState(loadPairings);
  const [pairing, setPairing] = useState(loadPairing);
  const [inviting, setInviting] = useState(false);
  const reload = useCallback(() => {
    setPairings(loadPairings());
    setPairing(loadPairing());
  }, []);
  const select = useCallback(
    (credentialId: string) => {
      selectPairing(credentialId);
      reload();
    },
    [reload]
  );
  const unpair = useCallback(
    (credentialId: string) => {
      removePairing(credentialId);
      reload();
    },
    [reload]
  );

  // Keys for everyone the account can tap arrive here; gone ones drop out.
  useEffect(() => {
    const sync = async () => {
      try {
        await syncThisBrowser();
        reload();
      } catch (error) {
        if (isSignedOutError(error)) {
          navigate({ to: "/signin", search: { redirect: "/tap" } });
        }
      }
    };
    sync();
    const wake = () => {
      if (document.visibilityState === "visible") {
        sync();
      }
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
    };
  }, [navigate, reload]);

  const ownColor = me?.profile?.color ?? pairing?.color ?? "cobalt";
  if (inviting) {
    return (
      <Frame color={ownColor}>
        <InvitePanel
          onDone={() => {
            setInviting(false);
          }}
        />
      </Frame>
    );
  }
  if (!pairing) {
    return (
      <Home
        color={ownColor}
        name={me?.profile?.name ?? null}
        onInvite={() => {
          setInviting(true);
        }}
      />
    );
  }
  // Keyed so each person gets their own outbox, socket and draft.
  return (
    <Composer
      key={pairing.credentialId}
      onInvite={() => {
        setInviting(true);
      }}
      onSelect={select}
      onUnpair={() => {
        unpair(pairing.credentialId);
      }}
      pairing={pairing}
      pairings={pairings}
    />
  );
};

/** "Add your people": nobody to tap yet. */
const Home = ({
  color,
  name,
  onInvite,
}: {
  color: PersonColor;
  name: string | null;
  onInvite: () => void;
}) => (
  <Frame color={color}>
    <Mark className="size-9" />
    <StepHeading title="Add your people">
      Invite someone to tap you and be tapped back, or open a link someone sent
      you.
    </StepHeading>
    <MiniTap color={color} name={name ?? "You"} />
    <div className="mt-auto flex flex-col gap-3">
      <button
        className="pill pill-frame w-full"
        onClick={onInvite}
        type="button"
      >
        <HugeiconsIcon className="size-5" icon={UserAdd01Icon} />
        Invite someone
      </button>
      <Link className="pill w-full" to="/join">
        <HugeiconsIcon className="size-5" icon={Link01Icon} />
        Got a link? Paste or scan
      </Link>
    </div>
    <Footer />
  </Frame>
);

const Footer = ({ children }: { children?: ReactNode }) => (
  <footer className="text-tone mt-auto pt-2 text-center text-[0.8125rem]">
    {children}
    <a className="text-ink underline underline-offset-[3px]" href="/account">
      Account
    </a>{" "}
    ·{" "}
    <a className="text-ink underline underline-offset-[3px]" href="/support">
      Help
    </a>
  </footer>
);

const Composer = ({
  pairing,
  pairings,
  onSelect,
  onUnpair,
  onInvite,
}: {
  pairing: Pairing;
  pairings: readonly Pairing[];
  onSelect: (credentialId: string) => void;
  onUnpair: () => void;
  onInvite: () => void;
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
  const {
    taps,
    outbox,
    requested,
    status,
    loaded,
    senderColor,
    senderName,
    resync,
    send,
    discard,
  } = useSender(pairing, handleRevoked);
  const [editingSelf, setEditingSelf] = useState(false);
  const [draft, setDraft] = usePersistedDraft(pairing.credentialId);
  const style = useMemo(() => loadStyle(localStorage), []);
  const [, setTick] = useState(0);
  const color =
    pairing.color ?? senderColor ?? fallbackColor(pairing.credentialId);
  // Compatibility with an older server during a server-first rollout.
  const paused = outbox.find((item) => item.paused);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // The recipient's inbox has the current name and color: pairings made
  // before colors learn theirs, and a change from another device shows here.
  useEffect(() => {
    const seenColor = senderColor ?? pairing.color;
    const seenName = senderName ?? pairing.senderName;
    if (seenColor !== pairing.color || seenName !== pairing.senderName) {
      updatePairing({ ...pairing, color: seenColor, senderName: seenName });
    }
  }, [pairing, senderColor, senderName]);

  const saveSelf = async (profile: { name: string; color: PersonColor }) => {
    await account.updateSendProfile(
      `${inboxOf(pairing.token)}:${pairing.credentialId}`,
      profile
    );
    // Their inbox has it now; the snapshot brings it to this pairing.
    await resync();
    setEditingSelf(false);
  };

  const submit = (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    setDraft("");
    send(trimmed, style);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(draft);
  };

  const unpair = () => {
    if (
      // oxlint-disable-next-line no-alert -- a native confirm is right for this rare action
      window.confirm(
        `Stop tapping ${pairing.recipientName}? This removes them from all your devices.`
      )
    ) {
      onUnpair();
      removePerson(pairing);
    }
  };

  return (
    <Frame color={color}>
      <header className="flex items-start justify-between gap-4">
        <RecipientPicker
          onInvite={onInvite}
          onSelect={onSelect}
          pairing={pairing}
          pairings={pairings}
        />
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
        <StyleLink
          color={color}
          draft={draft}
          sender={pairing.senderName}
          style={style}
        />
      </form>

      <section aria-labelledby="recent" className="flex flex-col">
        <h2 className="text-tone mb-1 text-sm font-bold" id="recent">
          Recent
        </h2>
        <ul className="divide-line flex flex-col divide-y">
          {outbox.map((item) => (
            <li className="py-4 first:pt-2" key={item.requestId}>
              <OutboxItem
                item={item}
                onDiscard={discard}
                onRetry={(body) => {
                  send(body, item.theme);
                }}
              />
            </li>
          ))}
          {taps.map((tap) => (
            <li className="py-4 first:pt-2" key={tap.id}>
              <TapItem
                recipientName={pairing.recipientName}
                requested={requested[tap.id]}
                tap={tap}
              />
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

      {editingSelf ? (
        <section aria-labelledby="seen-as" className="flex flex-col gap-3">
          <h2 className="text-sm font-bold" id="seen-as">
            How {pairing.recipientName} sees you
          </h2>
          <p className="text-tone text-[0.9375rem] leading-snug">
            Only {pairing.recipientName} sees this. It changes on your taps they
            already have too.
          </p>
          <SendProfileEditor
            initial={{ name: pairing.senderName, color }}
            onCancel={() => {
              setEditingSelf(false);
            }}
            onSave={saveSelf}
          />
        </section>
      ) : null}

      <Footer>
        Tapping as {pairing.senderName} ·{" "}
        <button
          className="text-ink underline underline-offset-[3px]"
          onClick={() => {
            setEditingSelf(true);
          }}
          type="button"
        >
          Change
        </button>{" "}
        ·{" "}
        <button
          className="text-ink underline underline-offset-[3px]"
          onClick={unpair}
          type="button"
        >
          Unpair
        </button>{" "}
        ·{" "}
      </Footer>
    </Frame>
  );
};

const SHOWCASE_MS = 3200;

/**
 * The way into Tap style, drawn as the tap itself: the style in use, or, on
 * Default, the draft cycling through the patron themes so the sender sees
 * what their words could look like before opening the page.
 */
const StyleLink = ({
  style,
  draft,
  sender,
  color,
}: {
  style: TapTheme;
  draft: string;
  sender: string;
  color: PersonColor;
}) => {
  const [shown, setShown] = useState(0);
  // The tap's clock, restamped as each theme arrives.
  const [at, setAt] = useState(() => new Date());
  const showcasing = style === "default";
  useEffect(() => {
    if (!showcasing || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const timer = setInterval(() => {
      setShown((n) => (n + 1) % PATRON_THEMES.length);
      setAt(new Date());
    }, SHOWCASE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [showcasing]);
  const theme = showcasing ? (PATRON_THEMES[shown] ?? "broadsheet") : style;
  const text = useDeferredValue(draft.trim()) || "Dinner's ready.";
  const tap = useMemo<PreviewTap>(
    () => ({ sender, text, color, at }),
    [sender, text, color, at]
  );
  return (
    <Link
      className="flex items-center gap-3 rounded-2xl p-2 pr-3 shadow-[inset_0_0_0_1.5px_var(--line)] transition-shadow hover:shadow-[inset_0_0_0_1.5px_var(--ink)]"
      to="/style"
    >
      <TapPreview
        className="w-[88px] shrink-0 rounded-[6px]"
        replay={0}
        tap={tap}
        theme={theme}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[1.0625rem] leading-tight font-bold">
          {showcasing ? (
            <>Send it as {THEME_NAMES[theme].name}</>
          ) : (
            <>Style: {THEME_NAMES[theme].name}</>
          )}
        </span>
        <span className="text-tone block text-[0.875rem] leading-snug">
          {showcasing
            ? "Patron themes for your taps"
            : "How everyone you tap sees it"}
        </span>
      </span>
      <HugeiconsIcon
        className="text-tone size-[18px]"
        icon={ArrowRight01Icon}
      />
    </Link>
  );
};

/** The unsent message, kept per person across leaving for the style page or
 * checkout. */
const usePersistedDraft = (credentialId: string) => {
  const [draft, setDraft] = useState(() =>
    loadDraft(localStorage, credentialId)
  );
  const update = useCallback(
    (text: string) => {
      setDraft(text);
      saveDraft(localStorage, credentialId, text);
    },
    [credentialId]
  );
  return [draft, update] as const;
};

const ADD_SOMEONE = "add";
const INVITE_SOMEONE = "invite";

/**
 * The heading doubles as a native picker: everyone this browser can tap,
 * plus ways to add someone new.
 */
const RecipientPicker = ({
  pairing,
  pairings,
  onSelect,
  onInvite,
}: {
  pairing: Pairing;
  pairings: readonly Pairing[];
  onSelect: (credentialId: string) => void;
  onInvite: () => void;
}) => {
  const navigate = useNavigate();
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
          } else if (value === INVITE_SOMEONE) {
            onInvite();
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
        <option value={INVITE_SOMEONE}>Invite someone…</option>
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
  requested,
}: {
  tap: Tap;
  recipientName: string;
  requested?: TapTheme;
}) => {
  const answered =
    tap.state === "acknowledged" && tap.response && tap.acknowledgedAt;
  const theme = tap.theme ?? "default";
  const note = downgradeNote(requested, tap);
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
          {theme === "default" ? null : `${THEME_NAMES[theme].name} · `}
          {relativeTime(tap.createdAt)}
        </time>
      </div>
      {note ? (
        <p className="text-tone -mt-1 text-[0.875rem] leading-snug">{note}</p>
      ) : null}
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

// Tapping needs an account: signed out (or without a name yet) goes to
// sign-in. Offline, the keys already on this browser still work.
export const Route = createFileRoute("/tap")({
  beforeLoad: async () => {
    const session = await loadSession();
    if (needsSignIn(session)) {
      throw redirect({
        to: "/signin",
        search: { redirect: "/tap" },
        replace: true,
      });
    }
    return { session };
  },
  component: TapComponent,
});
