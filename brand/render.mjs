// Renders Shouldertap banners to PNG: node brand/render.mjs [filter]
// Images render at 2x unless a job gives its own scale (exact-size uploads use 1).
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { chromium } = createRequire(join(root, "apps/web/package.json"))(
  "@playwright/test"
);
const font = readFileSync(
  join(
    root,
    "node_modules/.bun/@fontsource-variable+bricolage-grotesque@5.3.0/node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2"
  )
).toString("base64");

const sw = {
  moss: ["#1f5a3d", "#f4f1e8"],
  cobalt: ["#2340c8", "#f2f3fb"],
  plum: ["#6d2657", "#f8eef3"],
  tomato: ["#d9432b", "#fff4ef"],
  ochre: ["#e8b022", "#1f1a0e"],
  rose: ["#f2c4bd", "#3b1219"],
  sky: ["#9cc9ec", "#0d2233"],
  graphite: ["#2b2c30", "#f1f1ee"],
};
const light = {
  paper: "#f6f5f1",
  faint: "#ebe9e3",
  line: "#dedcd5",
  tone: "#6f6e69",
  ink: "#161616",
};
const dark = {
  paper: "#18181a",
  faint: "#232326",
  line: "#34343a",
  tone: "#9a9994",
  ink: "#f1f0ec",
};

const mark = (size, color = "currentColor") =>
  `<svg width="${size}" height="${size}" viewBox="-2.5 -8.65 44.65 44.65" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" style="flex:none;display:block"><path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/><path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/><path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/><path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/></svg>`;

const wordmark = (px, color) =>
  `<div style="display:flex;align-items:center;gap:${px * 0.32}px;color:${color};font-size:${px}px;font-weight:800;letter-spacing:-0.035em;line-height:1">${mark(px * 1.05)}<span>Shouldertap</span></div>`;

const pill = (label, bg, fg, border, px) =>
  `<span style="display:inline-flex;align-items:center;height:${px * 2.6}px;padding:0 ${px * 1.15}px;border-radius:999px;background:${bg};color:${fg};${border ? `box-shadow:inset 0 0 0 ${px * 0.09}px ${border};` : ""}font-size:${px}px;font-weight:700;letter-spacing:-0.01em">${label}</span>`;

const base = (
  w,
  h,
  body,
  bg
) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:B;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:200 800}
*{margin:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
body{font-family:B,system-ui;font-optical-sizing:auto;-webkit-font-smoothing:antialiased}
</style></head><body>${body}</body></html>`;

/** Product Frame: person color around a paper page, name on the top band, message on the page. */
const frame = ({
  w,
  h,
  color,
  t = light,
  who,
  message,
  msgPx,
  pitch,
  replies = true,
}) => {
  const [b, i] = sw[color];
  const f = Math.round(h * 0.045);
  const band = Math.round(h * 0.13);
  const pad = Math.round(h * 0.085);
  const r = Math.round(h * 0.06);
  const ui = Math.round(h * 0.026);
  return base(
    w,
    h,
    `<div style="position:absolute;inset:0;background:${b}">
  <div style="position:absolute;left:${f}px;right:${f}px;top:0;height:${band}px;display:flex;align-items:center;justify-content:space-between;color:${i}">
    ${wordmark(Math.round(band * 0.34), i)}
    <span style="font-size:${Math.round(band * 0.26)}px;font-weight:700;letter-spacing:-0.02em;opacity:.85">${who}</span>
  </div>
  <div style="position:absolute;left:${f}px;right:${f}px;top:${band}px;bottom:${f}px;background:${t.paper};border-radius:${r}px;padding:${pad}px;display:flex;flex-direction:column;justify-content:space-between">
    <div>
      <div style="color:${t.ink};font-size:${msgPx}px;font-weight:800;letter-spacing:-0.04em;line-height:.95;font-variation-settings:'opsz' 96">${message}</div>
      ${replies ? `<div style="display:flex;gap:${ui * 0.5}px;margin-top:${ui * 1.6}px">${pill("On it", b, i, null, ui)}${pill("In 10 min", "transparent", t.ink, t.line, ui)}${pill("Reply", "transparent", t.ink, t.line, ui)}</div>` : ""}
    </div>
    ${pitch ? `<div style="border-top:${Math.max(2, ui * 0.08)}px solid ${t.line};padding-top:${ui * 1.1}px;color:${t.ink};font-size:${ui * 1.15}px;font-weight:700;letter-spacing:-0.025em;line-height:1.15;max-width:34em">${pitch}</div>` : ""}
  </div>
</div>`,
    b
  );
};

/** Basic: neutral ground, wordmark, optional tagline. */
const plain = ({ w, h, t, px, tagline, align = "center", swatchRow = false }) =>
  base(
    w,
    h,
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:${{ center: "center", left: "flex-start", right: "flex-end" }[align]};padding:0 ${Math.round(w * 0.07)}px;gap:${px * 0.55}px;text-align:${align}">
  ${wordmark(px, t.ink)}
  ${tagline ? `<div style="color:${t.tone};font-size:${px * 0.34}px;font-weight:600;letter-spacing:-0.02em;line-height:1.2;max-width:24em">${tagline}</div>` : ""}
  ${
    swatchRow
      ? `<div style="display:flex;gap:${px * 0.16}px;margin-top:${px * 0.15}px">${Object.values(
          sw
        )
          .map(
            ([c]) =>
              `<span style="width:${px * 0.34}px;height:${px * 0.34}px;border-radius:999px;background:${c};box-shadow:inset 0 0 0 ${Math.max(2, px * 0.02)}px ${t.line}"></span>`
          )
          .join("")}</div>`
      : ""
  }
</div>`,
    t.paper
  );

/** Spectrum: the landing wipe frozen mid-flight, every person color flooding in from the top-left corner. */
const spectrum = ({ w, h, t = light, px, tagline }) => {
  const order = [
    "graphite",
    "plum",
    "moss",
    "cobalt",
    "sky",
    "ochre",
    "rose",
    "tomato",
  ];
  const max = Math.hypot(w, h) * 1.02;
  const rings = order
    .map((c, k) => {
      const rad = max * (1 - k / (order.length + 1.6));
      return `<div style="position:absolute;left:${-rad}px;top:${-rad}px;width:${rad * 2}px;height:${rad * 2}px;border-radius:50%;background:${sw[c][0]}"></div>`;
    })
    .join("");
  return base(
    w,
    h,
    `${rings}
<div style="position:absolute;right:${Math.round(h * 0.09)}px;bottom:${Math.round(h * 0.09)}px;background:${t.paper};border-radius:${Math.round(px * 0.7)}px;padding:${px * 0.6}px ${px * 0.75}px;display:flex;flex-direction:column;gap:${px * 0.3}px">
  ${wordmark(px, t.ink)}
  ${tagline ? `<div style="color:${t.tone};font-size:${px * 0.3}px;font-weight:600;letter-spacing:-0.02em">${tagline}</div>` : ""}
</div>`,
    t.paper
  );
};

/** Stack: the eight frames side by side, each a tiny tap. */
const stack = ({ w, h, t = light, px }) => {
  const people = [
    ["moss", "Sam", "Dinner's ready"],
    ["cobalt", "Alex", "Come here?"],
    ["rose", "Rosa", "Call me"],
    ["ochre", "Jo", "Trash day"],
    ["plum", "Mia", "Where are my keys"],
    ["sky", "Theo", "Movie at 8?"],
    ["tomato", "Lu", "Door!"],
    ["graphite", "Kai", "Need you"],
  ];
  const gap = Math.round(h * 0.035);
  const tile = h * 0.52;
  const cards = people
    .map(([c, who, m]) => {
      const [b, i] = sw[c];
      const fr = tile * 0.06;
      return `<div style="flex:none;width:${tile}px;height:${tile}px;background:${b};border-radius:${tile * 0.11}px;padding:${tile * 0.2}px ${fr}px ${fr}px;position:relative">
  <span style="position:absolute;left:${fr * 1.6}px;top:${tile * 0.06}px;color:${i};font-size:${tile * 0.08}px;font-weight:700">${who}</span>
  <div style="width:100%;height:100%;background:${t.paper};border-radius:${tile * 0.07}px;padding:${tile * 0.08}px;color:${t.ink};font-size:${tile * 0.13}px;font-weight:800;letter-spacing:-0.04em;line-height:.95">${m}</div>
</div>`;
    })
    .join("");
  return base(
    w,
    h,
    `<div style="position:absolute;left:${-w * 0.02}px;top:${h * 0.16}px;display:flex;gap:${gap}px;transform:rotate(-3deg);transform-origin:left top">${cards}${cards}</div>
<div style="position:absolute;right:${w * 0.045}px;bottom:${h * 0.12}px">${wordmark(px, t.ink)}</div>`,
    t.paper
  );
};

/** App icon: the mark in a person's ink on their base, as in apps/web/public/icon.svg. */
const icon = ({ s, color = "cobalt", rounded = false }) => {
  const [b, i] = sw[color];
  return base(
    s,
    s,
    `<div style="width:${s}px;height:${s}px;background:${b};border-radius:${rounded ? (s * 14) / 64 : 0}px;display:flex;align-items:center;justify-content:center">${mark((s * 38) / 64, i)}</div>`,
    "transparent"
  );
};

const pitchLine =
  "When someone at home needs you, their message covers your Mac until you answer.";
const tag = "A tap on the shoulder for your Mac.";

const jobs = {
  // Open Graph / link previews 1200x630
  "og/og-frame-cobalt": [
    1200,
    630,
    frame({
      w: 1200,
      h: 630,
      color: "cobalt",
      who: "Alex",
      message: "Can you come here?",
      msgPx: 108,
      pitch: pitchLine,
    }),
  ],
  "og/og-frame-moss": [
    1200,
    630,
    frame({
      w: 1200,
      h: 630,
      color: "moss",
      who: "Sam",
      message: "Dinner's ready",
      msgPx: 120,
      pitch: pitchLine,
    }),
  ],
  "og/og-frame-tomato-dark": [
    1200,
    630,
    frame({
      w: 1200,
      h: 630,
      color: "tomato",
      t: dark,
      who: "Lu",
      message: "Someone's at the door",
      msgPx: 104,
      pitch: pitchLine,
    }),
  ],
  "og/og-light": [
    1200,
    630,
    plain({
      w: 1200,
      h: 630,
      t: light,
      px: 96,
      tagline: pitchLine,
      swatchRow: true,
    }),
  ],
  "og/og-dark": [
    1200,
    630,
    plain({
      w: 1200,
      h: 630,
      t: dark,
      px: 96,
      tagline: pitchLine,
      swatchRow: true,
    }),
  ],
  "og/og-spectrum": [
    1200,
    630,
    spectrum({ w: 1200, h: 630, px: 64, tagline: tag }),
  ],

  // X / Twitter header 1500x500 (avatar covers bottom-left; content sits right)
  "x/x-header-spectrum": [
    1500,
    500,
    spectrum({ w: 1500, h: 500, px: 60, tagline: tag }),
  ],
  "x/x-header-spectrum-dark": [
    1500,
    500,
    spectrum({ w: 1500, h: 500, t: dark, px: 60, tagline: tag }),
  ],
  "x/x-header-stack": [1500, 500, stack({ w: 1500, h: 500, px: 52 })],
  "x/x-header-light": [
    1500,
    500,
    plain({ w: 1500, h: 500, t: light, px: 92, tagline: tag, swatchRow: true }),
  ],
  "x/x-header-dark": [
    1500,
    500,
    plain({ w: 1500, h: 500, t: dark, px: 92, tagline: tag, swatchRow: true }),
  ],

  // LinkedIn banner 1584x396
  "linkedin/li-banner-stack": [1584, 396, stack({ w: 1584, h: 396, px: 44 })],
  "linkedin/li-banner-stack-dark": [
    1584,
    396,
    stack({ w: 1584, h: 396, t: dark, px: 44 }),
  ],
  "linkedin/li-banner-light": [
    1584,
    396,
    plain({
      w: 1584,
      h: 396,
      t: light,
      px: 80,
      tagline: tag,
      align: "right",
      swatchRow: true,
    }),
  ],
  "linkedin/li-banner-dark": [
    1584,
    396,
    plain({
      w: 1584,
      h: 396,
      t: dark,
      px: 80,
      tagline: tag,
      align: "right",
      swatchRow: true,
    }),
  ],

  // GitHub social preview 1280x640
  "github/gh-social-frame": [
    1280,
    640,
    frame({
      w: 1280,
      h: 640,
      color: "cobalt",
      who: "Alex",
      message: "Can you come here?",
      msgPx: 112,
      pitch: pitchLine,
    }),
  ],
  "github/gh-social-dark": [
    1280,
    640,
    plain({
      w: 1280,
      h: 640,
      t: dark,
      px: 100,
      tagline: pitchLine,
      swatchRow: true,
    }),
  ],

  // Square 1080x1080, one per person color
  ...Object.fromEntries(
    [
      ["moss", "Sam", "Dinner's ready"],
      ["cobalt", "Alex", "Can you come here?"],
      ["plum", "Mia", "Have you seen my keys?"],
      ["tomato", "Lu", "Someone's at the door"],
      ["ochre", "Jo", "Take out the trash"],
      ["rose", "Rosa", "Call me"],
      ["sky", "Theo", "Movie at 8?"],
      ["graphite", "Kai", "Need you for a sec"],
    ].map(([c, who, m]) => [
      `square/sq-${c}`,
      [
        1080,
        1080,
        frame({
          w: 1080,
          h: 1080,
          color: c,
          who,
          message: m,
          msgPx: m.length > 16 ? 150 : 180,
          pitch: tag,
        }),
      ],
    ])
  ),
  "square/sq-light": [
    1080,
    1080,
    plain({
      w: 1080,
      h: 1080,
      t: light,
      px: 108,
      tagline: tag,
      swatchRow: true,
    }),
  ],
  "square/sq-dark": [
    1080,
    1080,
    plain({
      w: 1080,
      h: 1080,
      t: dark,
      px: 108,
      tagline: tag,
      swatchRow: true,
    }),
  ],

  // Wide 1920x1080 for decks, YouTube, desktop
  "wide/wide-frame-cobalt": [
    1920,
    1080,
    frame({
      w: 1920,
      h: 1080,
      color: "cobalt",
      who: "Alex",
      message: "Can you come here?",
      msgPx: 210,
      pitch: pitchLine,
    }),
  ],
  "wide/wide-frame-plum-dark": [
    1920,
    1080,
    frame({
      w: 1920,
      h: 1080,
      color: "plum",
      t: dark,
      who: "Mia",
      message: "Have you seen my keys?",
      msgPx: 190,
      pitch: pitchLine,
    }),
  ],
  "wide/wide-spectrum": [
    1920,
    1080,
    spectrum({ w: 1920, h: 1080, px: 96, tagline: tag }),
  ],
  "wide/wide-light": [
    1920,
    1080,
    plain({
      w: 1920,
      h: 1080,
      t: light,
      px: 150,
      tagline: tag,
      swatchRow: true,
    }),
  ],
  "wide/wide-dark": [
    1920,
    1080,
    plain({
      w: 1920,
      h: 1080,
      t: dark,
      px: 150,
      tagline: tag,
      swatchRow: true,
    }),
  ],

  // Creem storefront: banner 1920x400 and logo 52x52 at exact size, plus @2x
  ...Object.fromEntries(
    [
      ["stack", (t) => stack({ w: 1920, h: 400, t, px: 50 })],
      [
        "spectrum",
        (t) => spectrum({ w: 1920, h: 400, t, px: 52, tagline: tag }),
      ],
      [
        "plain",
        (t) =>
          plain({ w: 1920, h: 400, t, px: 84, tagline: tag, swatchRow: true }),
      ],
    ].flatMap(([k, make]) =>
      [
        ["", light],
        ["-dark", dark],
      ].flatMap(([d, t]) => [
        [`creem/creem-banner-${k}${d}`, [1920, 400, make(t), 1]],
        [`creem/creem-banner-${k}${d}@2x`, [1920, 400, make(t), 2]],
      ])
    )
  ),
  "creem/creem-logo": [52, 52, icon({ s: 52 }), 1],
  "creem/creem-logo@2x": [52, 52, icon({ s: 52 }), 2],
  "creem/creem-logo-rounded": [52, 52, icon({ s: 52, rounded: true }), 1],
  "creem/creem-logo-rounded@2x": [52, 52, icon({ s: 52, rounded: true }), 2],
  "logo/icon-cobalt-512": [512, 512, icon({ s: 512, rounded: true }), 1],

  // Lockups (transparent background)
  "logo/wordmark-ink": [
    1400,
    320,
    base(
      1400,
      320,
      `<div style="height:100%;display:flex;align-items:center;justify-content:center">${wordmark(170, light.ink)}</div>`,
      "transparent"
    ),
  ],
  "logo/wordmark-paper": [
    1400,
    320,
    base(
      1400,
      320,
      `<div style="height:100%;display:flex;align-items:center;justify-content:center">${wordmark(170, dark.ink)}</div>`,
      "transparent"
    ),
  ],
  "logo/wordmark-cobalt": [
    1400,
    320,
    base(
      1400,
      320,
      `<div style="height:100%;display:flex;align-items:center;justify-content:center">${wordmark(170, sw.cobalt[0])}</div>`,
      "transparent"
    ),
  ],
};

const [, , only] = process.argv;
const browser = await chromium.launch();
await Promise.all(
  Object.entries(jobs)
    .filter(([name]) => !only || name.includes(only))
    .map(async ([name, [w, h, html, scale = 2]]) => {
      const page = await browser.newPage({
        deviceScaleFactor: scale,
        viewport: { width: w, height: h },
      });
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      const out = join(here, `${name}.png`);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({
        path: out,
        omitBackground: name.startsWith("logo/") || name.includes("-logo"),
      });
      await page.close();
      console.log(name);
    })
);
await browser.close();
