import {
  BubbleChatIcon,
  Clock01Icon,
  ComputerIcon,
  SentIcon,
  Tick02Icon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type PersonColor, swatches } from "@shouldertap/domain";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { InkIcon, InkMark, InkText } from "@/components/ink";
import { Mark, Wordmark } from "@/components/mark";
import { useThemeColor } from "@/lib/frame";

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

/** The marketing page is a live tap: the frame cycles through a household. */
export function Landing() {
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

  // Hold the current tap while the visitor is pointing at or tabbing through it.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) {
      return;
    }
    const hold = () => setPaused(true);
    const release = () => setPaused(false);
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
    const sync = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
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
      wipe.onfinish = () => setFrom(nextColor);
      wipeRef.current = wipe;
    },
    [index, scene.color, scene.who]
  );

  useEffect(() => {
    if (paused || hidden || prefersReducedMotion()) {
      return;
    }
    const timer = setTimeout(() => advance(), SCENE_MS);
    return () => clearTimeout(timer);
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
    return () => window.removeEventListener("keydown", onKey);
  }, [advance]);

  return (
    <div
      className="paper-light frame-fill fixed inset-0 overflow-hidden text-frame-ink"
      ref={rootRef}
      style={
        {
          "--wipe-from": swatches[from].base,
          "--wipe-to": swatches[scene.color].base,
          "--frame": swatches[scene.color].base,
          "--frame-ink": swatches[scene.color].ink,
          "--ink-from": swatches[from].ink,
          "--ink-to": swatches[scene.color].ink,
        } as CSSProperties
      }
    >
      <header className="absolute inset-x-0 top-0 z-10 flex h-16 items-center gap-6 px-5 font-semibold text-[0.9375rem] md:h-24 md:px-[72px] md:text-lg">
        <a
          aria-label="Shouldertap home"
          className="mr-auto inline-flex items-center gap-[0.32em] font-extrabold text-xl tracking-[-0.035em] md:text-[1.625rem]"
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
        <span className="ink-fill inline-flex h-10 items-center whitespace-nowrap rounded-full px-4 font-bold text-sm md:h-[2.875rem] md:px-5 md:text-base">
          <span className="frame-fill-text">
            Coming soon<span className="hidden sm:inline">&nbsp;for Mac</span>
          </span>
        </span>
      </header>

      <main className="absolute inset-x-2.5 top-16 bottom-2.5 z-10 overflow-y-auto overscroll-contain rounded-[1.5rem] bg-paper text-ink md:inset-x-10 md:top-24 md:bottom-10 md:rounded-[1.75rem]">
        <section
          aria-label="A tap, live"
          className="flex min-h-full flex-col px-6 pt-10 pb-8 md:px-[72px] md:pt-16 md:pb-14"
          ref={heroRef}
        >
          <div className="flex flex-1 flex-col justify-center gap-7 md:gap-8">
            <p className="flex items-center gap-3 font-semibold text-lg text-tone md:text-[1.375rem]">
              <span className="frame-fill grid size-8 place-items-center rounded-full font-bold text-sm md:size-[2.125rem] md:text-[0.9375rem]">
                <InkText>{scene.who[0]}</InkText>
              </span>
              <b className="font-bold text-ink">{scene.who}</b>
              <span className="tabular-nums">just now</span>
            </p>
            <h2
              aria-live="polite"
              className="min-h-[1em] max-w-[11ch] animate-[rise-in_600ms_var(--ease-out-expo)] text-balance font-extrabold text-[clamp(3.5rem,11vw,9.5rem)] leading-[0.92] tracking-[-0.045em]"
              key={index}
            >
              {scene.message}
            </h2>
            <div className="flex flex-wrap gap-3">
              {REPLIES.map((reply, i) => (
                <button
                  className={`pill md:h-[4.25rem] md:px-7 md:text-2xl ${i === 0 ? "pill-fill frame-fill" : ""}`}
                  key={reply.key}
                  onClick={() => advance(reply.label)}
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

          <div className="mt-10 grid gap-6 border-line border-t-[1.5px] pt-8 md:mt-12 md:grid-cols-[1fr_auto] md:items-end md:gap-12 md:pt-9">
            <h1 className="max-w-[30em] text-balance font-bold text-[1.625rem] leading-[1.12] tracking-[-0.025em] md:text-[2.125rem]">
              When someone at home needs you, their message covers your Mac
              until you answer.{" "}
              <span className="text-tone">
                They see your reply the moment you send it.
              </span>
            </h1>
            <p
              aria-live="polite"
              className="flex min-h-7 items-center gap-2.5 font-semibold text-[1.0625rem] text-tone md:min-w-64 md:justify-end md:text-lg"
            >
              {answered ? (
                <>
                  <HugeiconsIcon
                    className="size-5 text-ink"
                    icon={Tick02Icon}
                  />
                  <span>
                    <b className="text-ink">{answered.who}</b> saw “
                    {answered.label}”
                  </span>
                </>
              ) : (
                <span className="hidden md:inline">
                  Try it: answer with 1, 2 or 3
                </span>
              )}
            </p>
          </div>
        </section>

        <HowItWorks
          earlier={SCENES[(index + 2) % SCENES.length] ?? scene}
          scene={scene}
        />
        <Consent />
        <Close />
      </main>
    </div>
  );
}

function Step({
  title,
  children,
  art,
  flip = false,
}: {
  title: string;
  children: React.ReactNode;
  art: React.ReactNode;
  flip?: boolean;
}) {
  return (
    <div
      className={`grid items-center gap-8 md:grid-cols-2 md:gap-16 ${flip ? "md:[&>*:first-child]:order-2" : ""}`}
    >
      <div className="flex max-w-md flex-col gap-3">
        <h3 className="text-balance font-extrabold text-[2rem] leading-[1.02] tracking-[-0.035em] md:text-[2.75rem]">
          {title}
        </h3>
        <p className="text-[1.0625rem] text-tone leading-relaxed md:text-lg">
          {children}
        </p>
      </div>
      <div className="flex justify-center">{art}</div>
    </div>
  );
}

/** Every illustration follows whoever is tapping in the hero right now. */
function HowItWorks({ scene, earlier }: { scene: Scene; earlier: Scene }) {
  return (
    <section
      aria-labelledby="how"
      className="flex scroll-mt-4 flex-col gap-20 px-6 py-20 md:gap-28 md:px-[72px] md:py-32"
    >
      <h2
        className="max-w-[16ch] text-balance font-extrabold text-[2.75rem] leading-[0.98] tracking-[-0.04em] md:text-[4.5rem]"
        id="how"
      >
        Harder to miss than a text. Kinder than yelling up the stairs.
      </h2>
      <Step art={<MiniMenuBar />} title="Invite them from your Mac">
        Shouldertap lives in your menu bar. Create an invite link and they scan
        it with their iPhone camera. Only people you invite can tap you.
      </Step>
      <Step
        art={<MiniPhone scene={scene} />}
        flip
        title="They tap you from their phone"
      >
        It opens in Safari, nothing to install. They pick a color so you know
        it's them, type what they need, and send.
      </Step>
      <Step
        art={<MiniOverlay scene={scene} />}
        title="It covers your screens until you answer"
      >
        Every display on every paired Mac, above full-screen apps. Answer with
        On it, In 10 min, or a quick reply. Answer on one Mac and it clears from
        all of them.
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
}

function MiniMenuBar() {
  return (
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
          <b className="font-bold font-sans text-[15px] tracking-[-0.02em]">
            Shouldertap
          </b>
          <span className="ml-auto flex items-center gap-1.5 text-[#6e6e73] text-[11px]">
            <i className="size-1.5 rounded-full bg-live" />
            Connected
          </span>
        </div>
        <div className="flex h-8 items-center justify-center gap-2 rounded-lg bg-[#1d1d1f] font-semibold text-white">
          <HugeiconsIcon className="size-4" icon={UserAdd01Icon} />
          Invite someone
        </div>
        <div>
          <p className="mb-1 font-semibold text-[#86868b] text-[11px]">
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
                className="grid size-6 place-items-center rounded-full font-bold font-sans text-[11px]"
                style={{ background: swatches[c].base, color: swatches[c].ink }}
              >
                {name[0]}
              </span>
              <div className="leading-tight">
                <div className="font-semibold">{name}</div>
                <div className="text-[#86868b] text-[11px]">{meta}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniPhone({ scene }: { scene: Scene }) {
  return (
    <div
      aria-hidden="true"
      className="frame-fill grid w-64 grid-rows-[2.25rem_1fr] rounded-[2.25rem] px-1.5 pb-1.5 text-frame-ink shadow-[0_30px_50px_-30px_rgb(0_0_0/0.5)]"
    >
      <div className="flex items-center justify-between px-6 pt-1 font-semibold text-xs">
        <InkText className="tabular-nums">7:41</InkText>
        <span className="h-5 w-20 rounded-full bg-black" />
        <InkText>5G</InkText>
      </div>
      <div className="flex flex-col gap-4 rounded-[1.875rem] bg-paper px-4 pt-5 pb-5 text-ink">
        <div className="flex items-start justify-between">
          <b className="font-extrabold text-2xl leading-none tracking-[-0.035em]">
            Tap {RECIPIENT}
          </b>
          <span className="flex items-center gap-1.5 pt-1 font-semibold text-[11px] text-tone">
            <i className="size-1.5 rounded-full bg-live" />
            Live
          </span>
        </div>
        <div className="min-h-20 rounded-2xl bg-faint px-3.5 py-3 text-[15px]">
          {scene.message}
        </div>
        <div className="pill pill-fill frame-fill pill-sm w-full">
          <InkIcon className="size-4" icon={SentIcon} />
          <InkText>Send tap</InkText>
        </div>
      </div>
    </div>
  );
}

function MiniOverlay({ scene }: { scene: Scene }) {
  return (
    <div
      aria-hidden="true"
      className="frame-fill relative aspect-[16/10] w-full max-w-[30rem] rounded-2xl px-3 pt-9 pb-3 text-frame-ink shadow-[0_30px_50px_-30px_rgb(0_0_0/0.5)]"
    >
      <div className="absolute top-2.5 left-5 flex items-baseline gap-2 font-bold text-sm">
        <InkText>{scene.who}</InkText>
        <InkText className="font-medium text-xs opacity-75">just now</InkText>
      </div>
      <div className="flex h-full flex-col justify-between rounded-xl bg-paper px-6 pt-8 pb-5 text-ink">
        <b className="font-extrabold text-[2.25rem] leading-[0.95] tracking-[-0.04em]">
          {scene.message}
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
}

function MiniAnswer({ scene, earlier }: { scene: Scene; earlier: Scene }) {
  return (
    <div
      aria-hidden="true"
      className="flex w-full max-w-sm flex-col gap-5 rounded-[1.5rem] bg-paper p-5 shadow-[0_0_0_1.5px_var(--line)]"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <b className="font-bold text-xl tracking-[-0.02em]">
            {scene.message}
          </b>
          <span className="text-[13px] text-tone">now</span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <i className="frame-fill h-[5px] rounded-full" />
          <i className="frame-fill h-[5px] animate-[pulse-soft_1.6s_ease-in-out_infinite] rounded-full" />
          <i className="h-[5px] rounded-full bg-faint" />
        </div>
        <div className="grid grid-cols-3 gap-1 font-semibold text-tone text-xs">
          <span className="text-ink">Sent</span>
          <span>On screen</span>
          <span>Answered</span>
        </div>
      </div>
      <div className="flex flex-col gap-3 border-line border-t pt-5">
        <div className="flex items-baseline justify-between">
          <b className="font-bold text-xl tracking-[-0.02em]">
            {earlier.message}
          </b>
          <span className="text-[13px] text-tone">13m</span>
        </div>
        <div className="flex items-center gap-2.5 rounded-2xl bg-faint px-3.5 py-3">
          <HugeiconsIcon className="size-5" icon={Tick02Icon} />
          <b className="font-bold">On it</b>
          <span className="ml-auto text-right text-[13px] text-tone tabular-nums leading-tight">
            8s later
            <br />
            on Studio
          </span>
        </div>
      </div>
    </div>
  );
}

function Consent() {
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
      <h2 className="mb-12 max-w-[18ch] text-balance font-extrabold text-[2.5rem] leading-none tracking-[-0.04em] md:mb-16 md:text-[3.5rem]">
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
}

function Close() {
  return (
    <section className="flex flex-col gap-10 px-6 pt-24 pb-10 md:px-[72px] md:pt-36">
      <p className="max-w-[12ch] text-balance font-extrabold text-[3.5rem] leading-[0.92] tracking-[-0.045em] md:text-[7rem]">
        Dinner's ready. Really.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <span className="pill pill-ink cursor-default">
          Coming soon for Mac
        </span>
        <span className="text-[0.9375rem] text-tone">
          Mac app plus any iPhone with Safari.
        </span>
      </div>
      <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-line border-t-[1.5px] pt-6 text-sm text-tone">
        <Wordmark className="text-ink text-lg" />
        <span>Made for households.</span>
      </footer>
    </section>
  );
}
