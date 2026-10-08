import {
  BubbleChatIcon,
  Clock01Icon,
  ComputerIcon,
  Download04Icon,
  SentIcon,
  Tick02Icon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { swatches } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { DocLinks } from "@/components/document";
import { InkIcon, InkMark, InkText } from "@/components/ink";
import { MacDownloadLink } from "@/components/mac-download-link";
import { Mark, Wordmark } from "@/components/mark";
import { Swept } from "@/components/swept";
import { WipeEdges } from "@/components/wipe-edges";
import { useThemeColor } from "@/lib/frame";
import { loadPairing } from "@/lib/pairing";

// Illustrative household: the demo's names and messages are not real users.
interface Scene {
  readonly color: PersonColor;
  readonly message: string;
  readonly who: string;
}

const SCENES: readonly Scene[] = [
  { who: "Sam", color: "moss", message: "Dinner's ready" },
  { who: "Alex", color: "cobalt", message: "Can you come here?" },
  { who: "Rosa", color: "rose", message: "Call me" },
  { who: "Jo", color: "ochre", message: "Take out the trash" },
];
const RECIPIENT = "Jamie";
const SCENE_MS = 5200;

const REPLIES = [
  { label: "On it", key: "1", icon: Tick02Icon },
  { label: "In 10 min", key: "2", icon: Clock01Icon },
  { label: "Reply", key: "3", icon: BubbleChatIcon },
] as const;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const Step = ({
  title,
  children,
  art,
  flip = false,
}: {
  title: string;
  children: React.ReactNode;
  art: React.ReactNode;
  flip?: boolean;
}) => (
  <div
    className={`grid items-center gap-8 md:grid-cols-2 md:gap-16 ${flip ? "md:[&>*:first-child]:order-2" : ""}`}
  >
    <div className="flex max-w-md flex-col gap-3">
      <h3 className="text-[2rem] leading-[1.02] font-extrabold tracking-[-0.035em] text-balance md:text-[2.75rem]">
        {title}
      </h3>
      <p className="text-tone text-[1.0625rem] leading-relaxed md:text-lg">
        {children}
      </p>
    </div>
    <div className="flex justify-center">{art}</div>
  </div>
);

const MiniMenuBar = () => (
  <div
    aria-hidden="true"
    className="relative h-72 w-full max-w-[26rem] overflow-hidden rounded-[1.25rem] bg-[radial-gradient(120%_90%_at_70%_10%,#50606b,#26303a_70%)] font-[system-ui] text-[13px]"
  >
    <div className="flex h-7 items-center justify-end gap-4 bg-black/25 px-3.5 font-medium text-white">
      <Mark className="size-4" />
      <span className="tabular-nums">7:42 PM</span>
    </div>
    <div className="absolute top-9 right-8 flex w-64 flex-col gap-3 rounded-xl bg-[#f6f6f4]/95 p-3 text-[#1d1d1f] shadow-[0_0_0_0.5px_rgb(0_0_0/0.25),0_20px_40px_-10px_rgb(0_0_0/0.45)]">
      <div className="flex items-center gap-2">
        <Mark className="size-5" />
        <b className="font-sans text-[15px] font-bold tracking-[-0.02em]">
          Shouldertap
        </b>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-[#6e6e73]">
          <i className="bg-live size-1.5 rounded-full" />
          Connected
        </span>
      </div>
      <div className="flex h-8 items-center justify-center gap-2 rounded-lg bg-[#1d1d1f] font-semibold text-white">
        <HugeiconsIcon className="size-4" icon={UserAdd01Icon} />
        Invite someone
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold text-[#86868b]">
          Can tap you
        </p>
        {(
          [
            ["Alex", "cobalt", "Active 5m ago"],
            ["Rosa", "rose", "Active yesterday"],
          ] as const
        ).map(([name, c, meta]) => (
          <div className="flex items-center gap-2.5 py-1" key={name}>
            <span
              className="grid size-6 place-items-center rounded-full font-sans text-[11px] font-bold"
              style={{ background: swatches[c].base, color: swatches[c].ink }}
            >
              {name[0]}
            </span>
            <div className="leading-tight">
              <div className="font-semibold">{name}</div>
              <div className="text-[11px] text-[#86868b]">{meta}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

const MiniPhone = ({ scene }: { scene: Scene }) => (
  <div
    aria-hidden="true"
    className="frame-fill text-frame-ink grid w-64 grid-rows-[2.25rem_1fr] rounded-[2.25rem] px-1.5 pb-1.5 shadow-[0_30px_50px_-30px_rgb(0_0_0/0.5)]"
  >
    <div className="flex items-center justify-between px-6 pt-1 text-xs font-semibold">
      <InkText className="tabular-nums">7:41</InkText>
      <span className="h-5 w-20 rounded-full bg-black" />
      <InkText>5G</InkText>
    </div>
    <div className="bg-paper text-ink flex flex-col gap-4 rounded-[1.875rem] px-4 pt-5 pb-5">
      <div className="flex items-start justify-between">
        <b className="text-2xl leading-none font-extrabold tracking-[-0.035em]">
          Tap {RECIPIENT}
        </b>
        <span className="text-tone flex items-center gap-1.5 pt-1 text-[11px] font-semibold">
          <i className="bg-live size-1.5 rounded-full" />
          Live
        </span>
      </div>
      <div className="bg-faint min-h-20 rounded-2xl px-3.5 py-3 text-[15px]">
        <Swept id={scene.who}>{scene.message}</Swept>
      </div>
      <div className="pill pill-fill frame-fill pill-sm w-full">
        <InkIcon className="size-4" icon={SentIcon} />
        <InkText>Send tap</InkText>
      </div>
    </div>
  </div>
);

const MiniOverlay = ({ scene }: { scene: Scene }) => (
  <div
    aria-hidden="true"
    className="frame-fill text-frame-ink relative aspect-[16/10] w-full max-w-[30rem] rounded-2xl px-3 pt-9 pb-3 shadow-[0_30px_50px_-30px_rgb(0_0_0/0.5)]"
  >
    <div className="absolute top-2.5 left-5 flex items-baseline gap-2 text-sm font-bold">
      <Swept id={scene.who}>
        <InkText>{scene.who}</InkText>
      </Swept>
      <InkText className="text-xs font-medium opacity-75">just now</InkText>
    </div>
    <div className="bg-paper text-ink flex h-full flex-col justify-between rounded-xl px-6 pt-8 pb-5">
      <b className="text-[2.25rem] leading-[0.95] font-extrabold tracking-[-0.04em]">
        <Swept id={scene.who}>{scene.message}</Swept>
      </b>
      <div className="flex gap-1.5">
        <span className="pill pill-fill frame-fill h-7 gap-1.5 px-3 text-xs">
          <InkIcon className="size-3.5" icon={Tick02Icon} />
          <InkText>On it</InkText>
        </span>
        <span className="pill h-7 gap-1.5 px-3 text-xs">
          <HugeiconsIcon className="size-3.5" icon={Clock01Icon} />
          In 10 min
        </span>
        <span className="pill h-7 gap-1.5 px-3 text-xs">
          <HugeiconsIcon className="size-3.5" icon={BubbleChatIcon} />
          Reply
        </span>
      </div>
    </div>
  </div>
);

const MiniAnswer = ({ scene, earlier }: { scene: Scene; earlier: Scene }) => (
  <div
    aria-hidden="true"
    className="bg-paper flex w-full max-w-sm flex-col gap-5 rounded-[1.5rem] p-5 shadow-[0_0_0_1.5px_var(--line)]"
  >
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <b className="text-xl font-bold tracking-[-0.02em]">
          <Swept id={scene.who}>{scene.message}</Swept>
        </b>
        <span className="text-tone text-[13px]">now</span>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <i className="frame-fill h-[5px] rounded-full" />
        <i className="frame-fill h-[5px] animate-[pulse-soft_1.6s_ease-in-out_infinite] rounded-full" />
        <i className="bg-faint h-[5px] rounded-full" />
      </div>
      <div className="text-tone grid grid-cols-3 gap-1 text-xs font-semibold">
        <span className="text-ink">Sent</span>
        <span>On screen</span>
        <span>Answered</span>
      </div>
    </div>
    <div className="border-line flex flex-col gap-3 border-t pt-5">
      <div className="flex items-baseline justify-between">
        <b className="text-xl font-bold tracking-[-0.02em]">
          <Swept id={scene.who}>{earlier.message}</Swept>
        </b>
        <span className="text-tone text-[13px]">13m</span>
      </div>
      <div className="bg-faint flex items-center gap-2.5 rounded-2xl px-3.5 py-3">
        <HugeiconsIcon className="size-5" icon={Tick02Icon} />
        <b className="font-bold">On it</b>
        <span className="text-tone ml-auto text-right text-[13px] leading-tight tabular-nums">
          8s later
          <br />
          on Studio
        </span>
      </div>
    </div>
  </div>
);

/** Every illustration follows whoever is tapping in the hero right now. */
const HowItWorks = ({ scene, earlier }: { scene: Scene; earlier: Scene }) => (
  <section
    aria-labelledby="how"
    className="flex scroll-mt-4 flex-col gap-20 px-6 py-20 md:gap-28 md:px-[72px] md:py-32"
  >
    <h2
      className="max-w-[16ch] text-[2.75rem] leading-[0.98] font-extrabold tracking-[-0.04em] text-balance md:text-[4.5rem]"
      id="how"
    >
      Harder to miss than a text. Kinder than yelling up the stairs.
    </h2>
    <Step art={<MiniMenuBar />} title="Invite them from your Mac">
      Shouldertap lives in your menu bar. Create an invite link and they scan it
      with their iPhone camera. Only people you invite can tap you.
    </Step>
    <Step
      art={<MiniPhone scene={scene} />}
      flip
      title="They tap you from their phone"
    >
      It opens in Safari, nothing to install. They pick a color so you know
      it&apos;s them, type what they need, and send.
    </Step>
    <Step
      art={<MiniOverlay scene={scene} />}
      title="It covers your screens until you answer"
    >
      Every display on every paired Mac, above full-screen apps. Answer with On
      it, In 10 min, or a quick reply. Answer on one Mac and it clears from all
      of them.
    </Step>
    <Step
      art={<MiniAnswer earlier={earlier} scene={scene} />}
      flip
      title="They know you saw it"
    >
      Their phone shows the tap arrive, land on your screen, and your answer,
      with how long it took.
    </Step>
  </section>
);

const Consent = () => {
  const facts = [
    {
      icon: UserAdd01Icon,
      text: "Only people you invite can tap you. Invite links work once and expire after a week.",
    },
    {
      icon: ComputerIcon,
      text: "Remove anyone from the menu bar at any time, and they can't tap you again.",
    },
    {
      icon: Tick02Icon,
      text: "Every tap ends with an answer, so nobody has to wonder if you saw it.",
    },
  ];
  return (
    <section className="bg-faint px-6 py-20 md:px-[72px] md:py-28">
      <h2 className="mb-12 max-w-[18ch] text-[2.5rem] leading-none font-extrabold tracking-[-0.04em] text-balance md:mb-16 md:text-[3.5rem]">
        Built for the people you live with, on your terms.
      </h2>
      <ul className="grid gap-8 md:grid-cols-3 md:gap-12">
        {facts.map((fact) => (
          <li className="flex flex-col gap-4" key={fact.text}>
            <HugeiconsIcon className="size-7" icon={fact.icon} />
            <p className="max-w-[32ch] text-[1.0625rem] leading-relaxed md:text-lg">
              {fact.text}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Creem's review requires the price to be easy to find on the site. */
const Pricing = () => {
  const points = [
    "Every feature from day one: unlimited taps, every Mac you own, and up to 20 people who can tap you.",
    "The people who tap you never pay. They use any iPhone with Safari.",
    "Not for you? Ask for a full refund within 14 days of buying.",
  ];
  return (
    <section
      aria-labelledby="pricing"
      className="flex scroll-mt-4 flex-col gap-10 px-6 py-20 md:px-[72px] md:py-28"
    >
      <h2
        className="max-w-[16ch] text-[2.75rem] leading-[0.98] font-extrabold tracking-[-0.04em] text-balance md:text-[4.5rem]"
        id="pricing"
      >
        Free for a week. Then $5, once.
      </h2>
      <div className="grid gap-10 md:grid-cols-[auto_1fr] md:gap-16">
        <div className="flex flex-col gap-2">
          <p className="text-[4rem] leading-none font-extrabold tracking-[-0.045em] md:text-[5.5rem]">
            $5
          </p>
          <p className="text-tone text-[1.0625rem] md:text-lg">
            One-time purchase, plus tax where it applies.
            <br />
            No subscription.
          </p>
        </div>
        <ul className="flex max-w-xl flex-col gap-4">
          <li className="text-[1.0625rem] leading-relaxed md:text-lg">
            Try everything free for 7 days. Then unlock Shouldertap on your Mac
            for good.
          </li>
          {points.map((point) => (
            <li
              className="text-tone text-[1.0625rem] leading-relaxed md:text-lg"
              key={point}
            >
              {point}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

const Close = () => (
  <section className="flex flex-col gap-10 px-6 pt-24 pb-10 md:px-[72px] md:pt-36">
    <p className="max-w-[12ch] text-[3.5rem] leading-[0.92] font-extrabold tracking-[-0.045em] text-balance md:text-[7rem]">
      Dinner&apos;s ready. Really.
    </p>
    <div className="flex flex-wrap items-center gap-4">
      <MacDownloadLink className="pill pill-ink">
        <HugeiconsIcon className="size-5" icon={Download04Icon} />
        Download for Mac
      </MacDownloadLink>
      <span className="text-tone text-[0.9375rem]">
        Free for 7 days, then $5 once. Mac app plus any iPhone with Safari.
      </span>
    </div>
    <footer className="border-line text-tone mt-16 flex flex-wrap items-center justify-between gap-4 border-t-[1.5px] pt-6 text-sm">
      <Wordmark className="text-ink text-lg" />
      <DocLinks />
      <span>Made for households.</span>
    </footer>
  </section>
);

/** The marketing page is a live tap: the frame cycles through a household. */
export const Landing = () => {
  const [index, setIndex] = useState(0);
  // The color the wipe starts from, and the one the frame's own text is set in.
  const [from, setFrom] = useState<PersonColor>(SCENES[0]?.color ?? "moss");
  const rootRef = useRef<HTMLDivElement>(null);
  const wipeRef = useRef<Animation | null>(null);
  const [answered, setAnswered] = useState<{
    who: string;
    label: string;
  } | null>(null);
  const [paused, setPaused] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const pairing = useMemo(() => loadPairing(), []);

  // Hold the current tap while the visitor is pointing at or tabbing through it.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) {
      return;
    }
    const hold = () => {
      setPaused(true);
    };
    const release = () => {
      setPaused(false);
    };
    hero.addEventListener("pointerenter", hold);
    hero.addEventListener("pointerleave", release);
    hero.addEventListener("focusin", hold);
    hero.addEventListener("focusout", release);
    return () => {
      hero.removeEventListener("pointerenter", hold);
      hero.removeEventListener("pointerleave", release);
      hero.removeEventListener("focusin", hold);
      hero.removeEventListener("focusout", release);
    };
  }, []);

  // A hidden tab draws no frames, so the sweep would stall while scenes kept
  // advancing underneath it; hold the cycle until the page is seen again.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sync = () => {
      setHidden(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const scene = SCENES[index] ?? SCENES[0];
  useThemeColor(swatches[scene.color].base);

  const advance = useCallback(
    (reply?: string) => {
      const next = (index + 1) % SCENES.length;
      const nextColor = SCENES[next]?.color ?? "cobalt";
      setAnswered(reply ? { who: scene.who, label: reply } : null);
      setIndex(next);
      const root = rootRef.current;
      if (!root || prefersReducedMotion()) {
        setFrom(nextColor);
        return;
      }
      setFrom(scene.color);
      wipeRef.current?.cancel();
      const wipe = root.animate(
        [{ "--wipe": "0px" }, { "--wipe": "145vmax" }],
        {
          duration: 700,
          easing: "cubic-bezier(0.65, 0, 0.35, 1)",
          fill: "forwards",
        }
      );
      wipe.onfinish = () => {
        setFrom(nextColor);
      };
      wipeRef.current = wipe;
    },
    [index, scene.color, scene.who]
  );

  useEffect(() => {
    if (paused || hidden || prefersReducedMotion()) {
      return;
    }
    const timer = setTimeout(() => {
      advance();
    }, SCENE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [advance, paused, hidden]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) {
        return;
      }
      const reply = REPLIES.find((r) => r.key === event.key);
      if (reply) {
        advance(reply.label);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [advance]);

  return (
    <div
      className="landing-frame paper-light text-frame-ink absolute inset-0 overflow-hidden"
      ref={rootRef}
      style={
        {
          // Avoid Safari's cached tint for fixed surfaces. The absolute
          // shell keeps the inner scroller while the document paints the bars.
          backgroundColor: swatches[scene.color].base,
          "--wipe-from": swatches[from].base,
          "--wipe-to": swatches[scene.color].base,
          "--frame": swatches[scene.color].base,
          "--frame-ink": swatches[scene.color].ink,
          "--ink-from": swatches[from].ink,
          "--ink-to": swatches[scene.color].ink,
        } as CSSProperties
      }
    >
      <WipeEdges
        frame={rootRef}
        from={swatches[from].base}
        to={swatches[scene.color].base}
      />
      <div
        aria-hidden="true"
        className="frame-fill pointer-events-none absolute inset-0"
      />
      <header className="landing-header absolute inset-x-0 z-10 flex h-16 items-center gap-6 px-5 text-[0.9375rem] font-semibold md:h-24 md:px-[72px] md:text-lg">
        <a
          aria-label="Shouldertap home"
          className="mr-auto inline-flex items-center gap-[0.32em] text-xl font-extrabold tracking-[-0.035em] md:text-[1.625rem]"
          href="/"
        >
          <InkMark className="size-[1.05em]" />
          <InkText>Shouldertap</InkText>
        </a>
        <a
          className="hidden opacity-85 hover:opacity-100 sm:inline"
          href="#how"
        >
          <InkText>How it works</InkText>
        </a>
        <a
          className="hidden opacity-85 hover:opacity-100 sm:inline"
          href="#pricing"
        >
          <InkText>Pricing</InkText>
        </a>
        {pairing ? (
          <a
            className="ink-fill inline-flex h-10 items-center rounded-full px-4 text-sm font-bold whitespace-nowrap transition-transform active:scale-[0.97] md:h-[2.875rem] md:px-5 md:text-base"
            href="/tap"
          >
            <span className="frame-fill-text">Tap {pairing.recipientName}</span>
          </a>
        ) : (
          <MacDownloadLink className="ink-fill inline-flex h-10 items-center rounded-full px-4 text-sm font-bold whitespace-nowrap transition-transform active:scale-[0.97] md:h-[2.875rem] md:px-5 md:text-base">
            <span className="frame-fill-text">
              Download<span className="hidden sm:inline">&nbsp;for Mac</span>
            </span>
          </MacDownloadLink>
        )}
      </header>

      <main className="landing-page bg-paper text-ink absolute inset-x-2.5 z-10 overflow-y-auto overscroll-contain rounded-[1.5rem] md:inset-x-10 md:rounded-[1.75rem]">
        <section
          aria-label="A tap, live"
          className="flex min-h-full flex-col px-6 pt-10 pb-8 md:px-[72px] md:pt-16 md:pb-14"
          ref={heroRef}
        >
          <div className="flex flex-1 flex-col justify-center gap-7 md:gap-8">
            <p className="text-tone flex items-center gap-3 text-lg font-semibold md:text-[1.375rem]">
              <span className="frame-fill grid size-8 place-items-center rounded-full text-sm font-bold md:size-[2.125rem] md:text-[0.9375rem]">
                <Swept id={index}>
                  <InkText>{scene.who[0]}</InkText>
                </Swept>
              </span>
              <b className="text-ink font-bold">
                <Swept id={index}>{scene.who}</Swept>
              </b>
              <span className="tabular-nums">just now</span>
            </p>
            <h2
              aria-live="polite"
              className="min-h-[1.84em] max-w-[11ch] text-[clamp(3.5rem,11vw,9.5rem)] leading-[0.92] font-extrabold tracking-[-0.045em] text-balance"
            >
              <Swept id={index}>{scene.message}</Swept>
            </h2>
            <div className="flex flex-wrap gap-3">
              {REPLIES.map((reply, i) => (
                <button
                  className={`pill md:h-[4.25rem] md:px-7 md:text-2xl ${i === 0 ? "pill-fill frame-fill" : ""}`}
                  key={reply.key}
                  onClick={() => {
                    advance(reply.label);
                  }}
                  type="button"
                >
                  {i === 0 ? (
                    <>
                      <InkIcon
                        className="size-5 md:size-[1.625rem]"
                        icon={reply.icon}
                      />
                      <InkText>{reply.label}</InkText>
                      <InkText className="hidden text-[0.9375rem] tabular-nums opacity-50 md:inline">
                        {reply.key}
                      </InkText>
                    </>
                  ) : (
                    <>
                      <HugeiconsIcon
                        className="size-5 md:size-[1.625rem]"
                        icon={reply.icon}
                      />
                      {reply.label}
                      <span className="hidden text-[0.9375rem] tabular-nums opacity-50 md:inline">
                        {reply.key}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="border-line mt-10 grid gap-6 border-t-[1.5px] pt-8 md:mt-12 md:grid-cols-[1fr_auto] md:items-end md:gap-12 md:pt-9">
            <h1 className="max-w-[30em] text-[1.625rem] leading-[1.12] font-bold tracking-[-0.025em] text-balance md:text-[2.125rem]">
              When someone at home needs you, their message covers your Mac
              until you answer.{" "}
              <span className="text-tone">
                They see your reply the moment you send it.
              </span>
            </h1>
            <p
              aria-live="polite"
              className="text-tone flex min-h-7 items-center gap-2.5 text-[1.0625rem] font-semibold md:min-w-64 md:justify-end md:text-lg"
            >
              <Swept id={index}>
                {answered ? (
                  <span className="flex items-center gap-2.5">
                    <HugeiconsIcon
                      className="text-ink size-5"
                      icon={Tick02Icon}
                    />
                    <span>
                      <b className="text-ink">{answered.who}</b> saw “
                      {answered.label}”
                    </span>
                  </span>
                ) : (
                  <span className="hidden md:inline">
                    Try it: answer with 1, 2 or 3
                  </span>
                )}
              </Swept>
            </p>
          </div>
        </section>

        <HowItWorks
          earlier={SCENES[(index + 2) % SCENES.length] ?? scene}
          scene={scene}
        />
        <Consent />
        <Pricing />
        <Close />
      </main>
    </div>
  );
};
