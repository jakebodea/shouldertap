import { swatches } from "@shouldertap/domain";
import type { PersonColor, TapTheme } from "@shouldertap/domain";

/**
 * The five tap compositions as a recipient's computer shows them, for the
 * sender's live preview. Each theme renders its own markup on a 1440×900
 * canvas, sizes its own message and plays its own arrival; nothing is a skin
 * over a shared overlay. Ported from the approved sketches; the Mac and
 * Windows renderers are the shipping originals.
 */

export interface PreviewTap {
  readonly sender: string;
  readonly text: string;
  readonly color: PersonColor;
  readonly at: Date;
}

// Highlighter strength for Note: light swatches can be bold, dark ones must
// stay readable under ink.
const HIGHLIGHT: Record<PersonColor, number> = {
  moss: 0.34,
  cobalt: 0.3,
  plum: 0.32,
  tomato: 0.42,
  ochre: 0.75,
  rose: 0.95,
  sky: 0.85,
  graphite: 0.28,
};

const ICON = {
  onIt: '<path d="M5 14L8.5 17.5L19 6.5"/>',
  in10: '<circle cx="12" cy="12" r="10"/><path d="M12 8V12L14 14"/>',
  reply:
    '<path d="M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12Z"/><path d="M12.1257 12H12.0007M8.125 12H8M16.125 12H16"/>',
} as const;
const icon = (k: keyof typeof ICON) =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
/** Everything a sender typed goes through this; no markup is ever theirs. */
const esc = (s: string) => s.replaceAll(/[&<>"]/gu, (c) => ESCAPES[c] ?? c);

const SPACE = /^\s+$/u;
const SPACES = /(?<space>\s+)/u;
/** Words as inline-block spans with real spaces between, never letter-split. */
const words = (text: string, inner = false) =>
  text
    .split(SPACES)
    .filter(Boolean)
    .map((part) => {
      if (SPACE.test(part)) {
        return " ";
      }
      return inner
        ? `<span class="w"><span class="wi">${esc(part)}</span></span>`
        : `<span class="w">${esc(part)}</span>`;
    })
    .join("");

/** The Mac app's curve: biggest for a few words, smaller for a paragraph. */
const preferred = (len: number, max: number, min: number) =>
  Math.round(
    max - (max - min) * Math.sqrt(Math.min(1, Math.max(0, (len - 14) / 70)))
  );

/** A computed CSS length like "12.5px" as a number. */
const px = (value: string) => Number(value.replace("px", "")) || 0;

const shrinkToFit = (
  msg: HTMLElement,
  slot: HTMLElement,
  max: number,
  min: number
) => {
  const cs = getComputedStyle(slot);
  const availH = slot.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  const availW = slot.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  const over = () =>
    msg.offsetHeight > availH + 1 || msg.scrollWidth > availW + 1;
  let size = max;
  msg.style.fontSize = `${size}px`;
  while (size > min && over()) {
    size -= 2;
    msg.style.fontSize = `${size}px`;
  }
};

/** Spread a stagger over a fixed budget: long messages arrive as fast. */
const stagger = (n: number, per: number, budget: number) =>
  Math.min(per, budget / Math.max(1, n - 1));
const anim = (
  el: Element | null,
  frames: Keyframe[],
  opts: KeyframeAnimationOptions
) => el?.animate(frames, { fill: "backwards", ...opts });
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

const lines = (els: HTMLElement[]) => {
  const out: HTMLElement[][] = [];
  let top: number | null = null;
  for (const el of els) {
    if (top === null || Math.abs(el.offsetTop - top) > 4) {
      out.push([]);
      top = el.offsetTop;
    }
    out.at(-1)?.push(el);
  }
  return out;
};

const all = (root: Element, selector: string) => [
  ...root.querySelectorAll<HTMLElement>(selector),
];
const one = (root: Element, selector: string) =>
  root.querySelector<HTMLElement>(selector);

const fitMessage = (
  root: Element,
  text: string,
  max: number,
  min: number,
  floor: number
) => {
  const msg = one(root, ".msg");
  const slot = one(root, ".slot");
  if (msg && slot) {
    shrinkToFit(msg, slot, preferred(text.length, max, min), floor);
  }
};

const clock = (at: Date) =>
  at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dateLine = (at: Date) =>
  at.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

interface Composition {
  readonly className: string;
  readonly render: (t: PreviewTap) => string;
  readonly fit: (root: HTMLElement, t: PreviewTap) => void;
  readonly enter: (root: HTMLElement) => void;
}

const COMPOSITIONS: Record<TapTheme, Composition> = {
  default: {
    className: "t-def",
    render: (
      t
    ) => `<div class="band"><span class="name">${esc(t.sender)}</span><span class="meta">now</span></div>
      <div class="page"><div class="slot"><p class="msg">${esc(t.text)}</p></div>
      <div class="acts"><span class="dp primary">${icon("onIt")}On it<span class="hint">1</span></span>
      <span class="dp">${icon("in10")}In 10 min<span class="hint">2</span></span>
      <span class="dp">${icon("reply")}Reply<span class="hint">3</span></span></div></div>`,
    fit: (root, t) => fitMessage(root, t.text, 156, 80, 36),
    enter: (root) => {
      anim(root, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 520,
        easing: EASE_OUT_EXPO,
      });
      anim(
        one(root, ".msg"),
        [{ transform: "translateY(18px)" }, { transform: "none" }],
        { duration: 520, easing: EASE_OUT_EXPO }
      );
    },
  },

  broadsheet: {
    className: "t-bs",
    render: (
      t
    ) => `<header class="mast"><span class="ear">${esc(dateLine(t.at))}</span><h2 class="plate">${esc(t.sender)}</h2><span class="ear r">now</span></header>
      <div class="rules" aria-hidden="true"><i></i><i></i></div>
      <div class="body"><div class="slot"><p class="msg">${words(t.text, true)}</p></div>
      <aside class="side"><div class="ans primary"><span class="n">1</span>On it</div>
      <div class="ans"><span class="n">2</span>In ten minutes</div>
      <div class="ans"><span class="n">3</span>Write back</div></aside></div>`,
    fit: (root, t) => {
      fitMessage(root, t.text, 210, 92, 40);
      const plate = one(root, ".plate");
      if (plate) {
        let size = px(getComputedStyle(plate).fontSize);
        while (size > 48 && plate.scrollWidth > plate.clientWidth + 1) {
          size -= 4;
          plate.style.fontSize = `${size}px`;
        }
      }
    },
    enter: (root) => {
      anim(root, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 260,
        easing: "ease-out",
      });
      for (const [i, rule] of all(root, ".rules i").entries()) {
        anim(rule, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
          duration: 640,
          delay: 60 + i * 90,
          easing: EASE_IN_OUT,
        });
      }
      anim(
        one(root, ".plate"),
        [
          { letterSpacing: "0.22em", opacity: 0 },
          { letterSpacing: "-0.02em", opacity: 1 },
        ],
        { duration: 620, easing: EASE_OUT_EXPO }
      );
      const ws = all(root, ".msg .wi");
      const step = stagger(ws.length, 34, 420);
      for (const [i, w] of ws.entries()) {
        anim(w, [{ transform: "translateY(108%)" }, { transform: "none" }], {
          duration: 560,
          delay: 180 + i * step,
          easing: EASE_OUT,
        });
      }
      anim(
        one(root, ".side"),
        [
          { opacity: 0, transform: "translateX(14px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 420, delay: 380, easing: EASE_OUT }
      );
    },
  },

  billboard: {
    className: "t-bb",
    render: (
      t
    ) => `<div class="rail"><span class="name">${esc(t.sender)}</span><span class="ago">now</span></div>
      <div class="main"><div class="kick"><span>Tap from ${esc(t.sender)}</span><span></span></div>
      <div class="slot"><p class="msg">${words(t.text)}</p></div></div>
      <div class="strip"><span class="blk primary">On it<span class="n">1</span></span>
      <span class="blk">In 10 min<span class="n">2</span></span>
      <span class="blk">Reply<span class="n">3</span></span></div>`,
    fit: (root, t) => {
      fitMessage(root, t.text, 270, 108, 44);
      const name = one(root, ".rail .name");
      const rail = one(root, ".rail");
      if (name && rail) {
        let size = px(getComputedStyle(name).fontSize);
        while (size > 40 && name.offsetHeight > rail.clientHeight - 140) {
          size -= 6;
          name.style.fontSize = `${size}px`;
        }
      }
    },
    enter: (root) => {
      anim(
        root,
        [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
        { duration: 420, easing: EASE_IN_OUT }
      );
      anim(
        one(root, ".rail .name"),
        [
          { transform: "rotate(180deg) translateY(-40%)", opacity: 0 },
          { transform: "rotate(180deg)", opacity: 1 },
        ],
        { duration: 560, delay: 160, easing: EASE_OUT_EXPO }
      );
      const ws = all(root, ".msg .w");
      // Lock each word to its final width so the weight surge never rewraps.
      for (const w of ws) {
        w.style.width = `${w.offsetWidth + 2}px`;
        w.style.textAlign = "center";
        w.style.whiteSpace = "nowrap";
      }
      const step = stagger(ws.length, 70, 520);
      let last: Animation | undefined;
      for (const [i, w] of ws.entries()) {
        last = anim(
          w,
          [
            {
              opacity: 0,
              fontWeight: 100,
              transform: "translateY(0.28em) scale(1.12)",
            },
            { opacity: 1, offset: 0.35 },
            { opacity: 1, fontWeight: 900, transform: "none" },
          ],
          { duration: 460, delay: 260 + i * step, easing: EASE_OUT }
        );
      }
      if (last) {
        last.onfinish = () => {
          for (const w of ws) {
            w.style.width = "";
            w.style.textAlign = "";
            w.style.whiteSpace = "";
          }
        };
      }
      anim(
        one(root, ".strip"),
        [{ transform: "translateY(100%)" }, { transform: "none" }],
        { duration: 480, delay: 320, easing: EASE_OUT_EXPO }
      );
      anim(one(root, ".kick"), [{ opacity: 0 }, { opacity: 1 }], {
        duration: 300,
        delay: 300,
        easing: "ease-out",
      });
    },
  },

  terminal: {
    className: "t-tm",
    render: (t) => {
      const handle = t.sender.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
      return `<div class="bar"><span><span class="dot"></span><b>${esc(t.sender)}</b></span><span>tty/desk</span><span class="sp"></span><span>now</span></div>
        <div class="scr"><div class="cmd">$ tap --from ${esc(handle)}</div>
        <div class="slot"><p class="msg">${words(t.text)}<span class="cur" aria-hidden="true"></span></p></div>
        <div class="menu"><span class="opt primary"><span class="k">[1]</span> on it</span>
        <span class="opt"><span class="k">[2]</span> in 10 min</span>
        <span class="opt"><span class="k">[3]</span> reply</span></div></div>`;
    },
    fit: (root, t) => fitMessage(root, t.text, 168, 84, 40),
    enter: (root) => {
      anim(root, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 120,
        easing: "linear",
      });
      anim(
        one(root, ".scr"),
        [
          { transform: "scaleY(0.006) scaleX(0.7)", filter: "brightness(4)" },
          {
            transform: "scaleY(0.006) scaleX(1)",
            filter: "brightness(4)",
            offset: 0.35,
          },
          { transform: "none", filter: "brightness(1)" },
        ],
        { duration: 300, easing: EASE_OUT }
      );
      anim(
        one(root, ".bar"),
        [{ transform: "translateY(-100%)" }, { transform: "none" }],
        { duration: 320, delay: 120, easing: EASE_OUT_EXPO }
      );
      const ws = all(root, ".msg .w");
      const step = stagger(ws.length, 55, 600);
      for (const [i, w] of ws.entries()) {
        anim(w, [{ opacity: 0 }, { opacity: 1 }], {
          duration: 1,
          delay: 300 + i * step,
        });
      }
      const doneAt = 300 + (ws.length - 1) * step;
      const cursor = one(root, ".cur");
      anim(cursor, [{ opacity: 0 }, { opacity: 0 }], {
        duration: doneAt,
        fill: "none",
      });
      // Blinks three times, then stops: nothing loops.
      anim(
        cursor,
        [
          { opacity: 1 },
          { opacity: 0, offset: 0.5 },
          { opacity: 0, offset: 0.99 },
          { opacity: 1 },
        ],
        {
          duration: 900,
          iterations: 3,
          easing: "steps(1, end)",
          delay: doneAt,
          fill: "none",
        }
      );
      anim(one(root, ".menu"), [{ opacity: 0 }, { opacity: 1 }], {
        duration: 1,
        delay: Math.min(doneAt + 60, 700),
      });
    },
  },

  note: {
    className: "t-nt",
    render: (t) => {
      const box =
        '<svg class="box" viewBox="0 0 36 36" aria-hidden="true"><path d="M5 6.5c8-1.2 17-1.4 26-.4.7 8 .9 15.6.3 23.6-8.6.9-17 .8-25.6.1C5 22 4.6 14 5 6.5Z"/></svg>';
      return `<div class="stack"><div class="sheet"><span class="tape" aria-hidden="true"></span>
        <div class="head"><span>${esc(clock(t.at))}</span><span></span></div>
        <div class="slot"><p class="msg">${words(t.text)}</p></div>
        <div class="sig">— ${esc(t.sender)}</div>
        <div class="ticks"><span class="tick primary">${box}<span class="lbl">On it</span><span class="k">1</span></span>
        <span class="tick">${box}<span class="lbl">In 10 min</span><span class="k">2</span></span>
        <span class="tick">${box}<span class="lbl">Reply</span><span class="k">3</span></span></div></div></div>`;
    },
    fit: (root, t) => fitMessage(root, t.text, 150, 76, 40),
    enter: (root) => {
      anim(root, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 240,
        easing: "ease-out",
      });
      anim(
        one(root, ".sheet"),
        [
          { transform: "translateY(70px) rotate(-5deg)", opacity: 0 },
          { transform: "rotate(-1.1deg)", opacity: 1 },
        ],
        { duration: 560, easing: EASE_OUT_EXPO }
      );
      anim(
        one(root, ".tape"),
        [
          { transform: "rotate(-3deg) scale(1.25)", opacity: 0 },
          { transform: "rotate(-3deg)", opacity: 0.88 },
        ],
        { duration: 180, delay: 420, easing: EASE_OUT }
      );
      // Write each line left to right; time per word follows its length.
      const ws = all(root, ".msg .w");
      const raw = ws.map((w) =>
        Math.max(40, ((w.textContent?.length ?? 0) + 1) * 22)
      );
      const scale = Math.min(
        1,
        900 /
          Math.max(
            1,
            raw.reduce((a, b) => a + b, 0)
          )
      );
      let at = 360;
      for (const line of lines(ws)) {
        for (const w of line) {
          const duration = (raw[ws.indexOf(w)] ?? 40) * scale;
          anim(
            w,
            [
              { clipPath: "inset(-30% 100% -30% -8%)" },
              { clipPath: "inset(-30% -8% -30% -8%)" },
            ],
            { duration, delay: at, easing: "linear" }
          );
          at += duration;
        }
      }
      anim(
        one(root, ".sig"),
        [
          { clipPath: "inset(-30% 100% -30% -8%)" },
          { clipPath: "inset(-30% -8% -30% -8%)" },
        ],
        { duration: 260, delay: at, easing: "linear" }
      );
      anim(
        one(root, ".ticks"),
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 320, delay: Math.min(at, 900), easing: EASE_OUT }
      );
    },
  },
};

/**
 * Draws `theme` into `canvas` and, if asked, plays its arrival. Reduced
 * motion is the same endpoint for every theme: the composed screen, faded in
 * over 160ms.
 */
export const drawTap = (
  canvas: HTMLElement,
  theme: TapTheme,
  tap: PreviewTap,
  { animate, reduced }: { animate: boolean; reduced: boolean }
) => {
  for (const running of canvas.getAnimations({ subtree: true })) {
    running.cancel();
  }
  const swatch = swatches[tap.color];
  canvas.style.setProperty("--base", swatch.base);
  canvas.style.setProperty("--onbase", swatch.ink);
  canvas.style.setProperty(
    "--hl",
    `color-mix(in oklab, ${swatch.base} ${Math.round(HIGHLIGHT[tap.color] * 100)}%, transparent)`
  );
  const composition = COMPOSITIONS[theme];
  const root = document.createElement("div");
  root.className = `tap ${composition.className}`;
  // oxlint-disable-next-line no-unsanitized/property -- every sender string goes through esc()
  root.innerHTML = composition.render(tap);
  canvas.replaceChildren(root);
  composition.fit(root, tap);
  if (!animate) {
    return;
  }
  if (reduced) {
    anim(root, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 160,
      easing: "ease-out",
    });
  } else {
    composition.enter(root);
  }
};

/** Every family a theme uses, so a preview never lays out in a fallback. */
export const loadThemeFonts = async () => {
  try {
    await Promise.all(
      [
        "800 40px 'Bricolage Grotesque Variable'",
        "400 40px 'Instrument Serif'",
        "italic 400 40px 'Instrument Serif'",
        "900 40px 'Big Shoulders Display'",
        "40px VT323",
        "500 20px 'Geist Mono'",
        "700 40px Caveat",
      ].map((font) => document.fonts.load(font))
    );
  } catch {
    // Lays out in whatever loaded; the next draw picks up the rest.
  }
};
