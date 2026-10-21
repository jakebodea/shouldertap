import { execFileSync } from "node:child_process";
/* eslint-disable no-await-in-loop -- Render one large image at a time to bound memory. */
// Real captures, with shared device framing. Run: node brand/app-store/render.mjs
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  deviceCss,
  phone,
  loupe,
  monitor,
  laptop,
  browserFrame,
} from "./devices.mjs";

const here = import.meta.dirname;
const { chromium } = createRequire(
  path.join(here, "../../apps/web/package.json")
)("@playwright/test");
const font = readFileSync(
  path.join(
    here,
    "../../apps/web/node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2"
  )
).toString("base64");
const data = (file) =>
  `data:image/png;base64,${readFileSync(path.join(here, file)).toString("base64")}`;
const capture = (name) => data(`captures/${name}.png`);
const mac = capture("mac-overlay");
const takeover = capture("iphone-takeover");
const compact = capture("iphone-island-compact");
const expanded = capture("iphone-island-expanded");
const lock = capture("iphone-lock-screen");
const web = capture("web-sender");
const reply = capture("03-reply");

// Regions of the captures, in capture pixels (1206 × 2622 for iPhone).
const regions = {
  compactIsland: [373, 42, 483, 110],
  lockActivity: [49, 1760, 1108, 474],
  replyAnswer: [40, 1368, 1126, 432],
};
// The web capture is a 1200 × 900 viewport at 2×; the sender page is centered.
const webSource = { width: 2400, height: 1800 };

// The mark from docs/design.md.
const mark = `<svg class="mark" viewBox="-2.5 -8.65 44.65 44.65" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/><path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/><path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/><path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/></svg>`;
// The mark's three knock marks, landing on a device's top-right shoulder.
const knock = (left, top, size, color) =>
  `<svg style="position:absolute;left:${left}px;top:${top}px;width:${size}px;height:${size}px" viewBox="0 0 20 20" fill="none" stroke="${color}" stroke-linecap="round" stroke-width="2.4"><path d="M2.5 9.2L5.6 1"/><path d="M7.3 12.6L13.5 6.4"/><path d="M10.8 17.4L19 14.3"/></svg>`;

// A phone placed on the canvas, plus where a capture region lands on it.
const placePhone = (src, { left, top, width, islandInCapture }) => {
  const scale = (width * 0.94) / 1206;
  const inset = width * 0.03;
  return {
    html: `<div style="position:absolute;left:${left}px;top:${top}px">${phone(src, { width, islandInCapture })}</div>`,
    center: ([x, y, w, h]) => ({
      x: left + inset + (x + w / 2) * scale,
      y: top + inset + (y + h / 2) * scale,
    }),
    bottom: top + width * 2.104,
  };
};
// Enlarge a region of a placed phone's capture, centered over where it sits.
const zoom = (placed, src, box, { width, radius, dx = 0, dy = 0 }) => {
  const { x, y } = placed.center(box);
  const height = (box[3] * width) / box[2];
  return loupe(src, {
    box,
    width,
    radius,
    left: Math.round(x - width / 2 + dx),
    top: Math.round(y - height / 2 + dy),
  });
};
const at = (left, top, html, z = 1) =>
  `<div style="position:absolute;left:${left}px;top:${top}px;z-index:${z}">${html}</div>`;

const css = `@font-face{font-family:B;src:url(data:font/woff2;base64,${font});font-weight:200 800}*{box-sizing:border-box}body{margin:0;font-family:B,sans-serif;font-variation-settings:"opsz" 96}h1{margin:0;font-weight:800;letter-spacing:-.04em;line-height:.98}p{margin:0;font-weight:500;font-variation-settings:"opsz" 24}.brand{display:flex;align-items:center;gap:.32em;font-weight:800;letter-spacing:-.035em}.mark{width:1.05em;height:1.05em}.note{font-weight:500;font-variation-settings:"opsz" 14;opacity:.78}${deviceCss}`;

const graphite = { bg: "#2b2c30", ink: "#f1f1ee" };
const slides = [
  (() => {
    const p = placePhone(takeover, { left: 92, top: 372, width: 476 });
    return {
      name: "01-hard-to-miss",
      title: "A tap that’s<br>hard to miss.",
      sub: "From someone you know.<br>Right across your screen.",
      ...graphite,
      art: `${p.html}${knock(540, 350, 50, "#f1f1ee")}`,
    };
  })(),
  (() => {
    const p = placePhone(expanded, {
      left: 70,
      top: 520,
      width: 520,
      islandInCapture: true,
    });
    const pill = 483 * 0.66;
    return {
      name: "02-dynamic-island",
      title: "A familiar face.<br>In your Island.",
      sub: "See who’s tapping. Press and hold to answer.",
      bg: "#2340c8",
      ink: "#f2f3fb",
      art: `${loupe(compact, { box: regions.compactIsland, width: pill, radius: 999, left: Math.round(330 - pill / 2), top: 370 })}<div class="hold" style="top:${370 + 110 * 0.66 + 18}px">Press and hold</div>${p.html}`,
    };
  })(),
  (() => {
    const p = placePhone(lock, { left: 110, top: 372, width: 440 });
    return {
      name: "03-lock-screen",
      title: "Right on your<br>Lock Screen.",
      sub: "Answer “On it” or “In 10 min”<br>right from the Lock Screen.",
      bg: "#6d2657",
      ink: "#f8eef3",
      art: `${p.html}${zoom(p, lock, regions.lockActivity, { width: 580, radius: 25, dy: -10 })}`,
    };
  })(),
  {
    name: "04-connected-screens",
    title: "One tap.<br>Every linked screen.",
    sub: "Every display on their Mac, plus their linked iPhone. One answer clears them all.",
    bg: "#e8b022",
    ink: "#1f1a0e",
    art: `${at(40, 420, monitor(mac, 580))}${at(52, 880, laptop(mac, 380), 2)}${placePhone(takeover, { left: 392, top: 770, width: 236 }).html.replace("position:absolute", "position:absolute;z-index:3")}`,
  },
  {
    name: "05-browser",
    title: "A browser.<br>A little tap.",
    sub: "Invited people can send from the web. It reaches every linked screen.",
    bg: "#9cc9ec",
    ink: "#0d2233",
    art: `${at(28, 392, browserFrame(web, { width: 560, crop: [500, 0, 1400, 1800], source: webSource }))}${placePhone(takeover, { left: 392, top: 856, width: 240 }).html.replace("position:absolute", "position:absolute;z-index:3")}`,
  },
  (() => {
    const p = placePhone(reply, { left: 110, top: 372, width: 440 });
    return {
      name: "06-reply",
      title: "Get an answer.<br>Carry on.",
      sub: "Their reply comes straight back, and says where they saw it.",
      bg: "#f2c4bd",
      ink: "#3b1219",
      art: `${p.html}${zoom(p, reply, regions.replyAnswer, { width: 580, radius: 22 })}`,
    };
  })(),
];
const portrait = (s) =>
  `<!doctype html><html><head><style>${css}body{width:660px;height:1434px;background:${s.bg};color:${s.ink};padding:46px 46px 0;position:relative;overflow:hidden}header{display:flex;justify-content:space-between;align-items:center}.brand{font-size:23px}.note{font-size:13.5px}h1{margin-top:44px;font-size:68px}p{margin-top:18px;font-size:22px;line-height:1.32;max-width:520px}.hold{position:absolute;left:0;right:0;text-align:center;font-size:17px;font-weight:600;opacity:.85}.hold:after{content:"";display:block;width:2px;height:22px;margin:8px auto 0;background:currentColor;opacity:.6;border-radius:2px}</style></head><body><header><div class="brand">${mark}Shouldertap</div></header><h1>${s.title}</h1><p>${s.sub}</p>${s.art}</body></html>`;

const heroPhone = placePhone(lock, { left: 1548, top: 236, width: 300 });
const wide = `<!doctype html><html><head><style>${css}body{width:1920px;height:1080px;background:#f6f5f1;color:#161616;padding:84px 90px;position:relative;overflow:hidden}.brand{font-size:30px}h1{font-size:96px;margin-top:150px}p{font-size:27px;line-height:1.35;margin-top:26px;color:#3d3c39}.note{position:absolute;left:90px;bottom:60px;font-size:18px;color:#6f6e69;opacity:1}</style></head><body><div class="brand">${mark}Shouldertap</div><h1>A little tap.<br>Across your<br>screens.</h1><p>Send a tap. Get an answer.<br>Across your screens.</p>${at(736, 92, monitor(mac, 760))}${at(690, 640, laptop(mac, 430), 2)}${at(1182, 520, browserFrame(web, { width: 340, crop: [500, 0, 1400, 1800], source: webSource }), 3)}${heroPhone.html.replace("position:absolute", "position:absolute;z-index:4")}${zoom(heroPhone, lock, regions.lockActivity, { width: 380, radius: 17, dx: -24 })}</body></html>`;

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const exportsPath = path.join(here, "exports");
mkdirSync(exportsPath, { recursive: true });
// This directory contains only this generator's products; remove superseded slide names.
for (const file of readdirSync(exportsPath)) {
  if (file.endsWith(".png")) {
    unlinkSync(path.join(exportsPath, file));
  }
}
// Scale to cover: the medium size is 0.1% taller than 660:1434, so a sub-pixel strip is cropped
// at the right instead of leaving a background seam under bleeding devices.
const render = async (html, file, width, height, baseWidth, baseHeight) => {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(html);
    await page.evaluate(
      ({ w, h, bw, bh }) => {
        document.body.style.transform = `scale(${Math.max(w / bw, h / bh)})`;
        document.body.style.transformOrigin = "top left";
        document.documentElement.style.overflow = "hidden";
      },
      { w: width, h: height, bw: baseWidth, bh: baseHeight }
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(exportsPath, file) });
  } finally {
    await page.close();
  }
};
const sizes = [
  ["large", 1320, 2868],
  ["medium", 1206, 2622],
];
try {
  for (const slide of slides) {
    for (const [label, width, height] of sizes) {
      await render(
        portrait(slide),
        `${slide.name}-${label}.png`,
        width,
        height,
        660,
        1434
      );
    }
  }
  await render(
    wide,
    "marketing-screen-story-1920x1080.png",
    1920,
    1080,
    1920,
    1080
  );
  const gallery = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{background:#f6f5f1;color:#161616;padding:40px;max-width:1500px;margin:auto}h1{font-size:40px;margin-top:24px}.brand{font-size:22px}.row{display:flex;gap:18px;overflow:auto;margin:30px 0}.row a{flex:none}.row img{width:228px;border-radius:14px;display:block}p{font-size:17px;line-height:1.45;max-width:80ch;margin-top:14px;color:#3d3c39}.wide{width:100%;border-radius:10px;display:block}</style></head><body><div class="brand">${mark}Shouldertap</div><h1>Screen experiences · App Store draft v3</h1><p>Real native and web views with fictional Sam and Alex, composed into authored device frames. Enlarged details are the same capture pixels, not redrawn UI. Verify against the approved binary before uploading.</p><div class="row">${slides.map((s) => `<a href="exports/${s.name}-large.png"><img alt="${s.name}" src="${data(`exports/${s.name}-large.png`)}"></a>`).join("")}</div><img class="wide" alt="From browser to connected screens" src="${data("exports/marketing-screen-story-1920x1080.png")}"><p>Six App Store images at 1320 × 2868 and 1206 × 2622, plus one 1920 × 1080 marketing image. The repeated Mac overlay illustrates one Mac with two displays; this is not a multi-device delivery test.</p></body></html>`;
  writeFileSync(path.join(here, "index.html"), gallery);
  writeFileSync(
    path.join(here, "manifest.json"),
    `${JSON.stringify(
      {
        version: 3,
        screens: slides.map((s) => s.name),
        sizes: sizes.map(([, w, h]) => [w, h]),
        marketing: ["marketing-screen-story-1920x1080.png"],
        status: "draft-not-uploaded",
      },
      null,
      2
    )}\n`
  );
  execFileSync(path.join(here, "../../node_modules/.bin/oxfmt"), [
    path.join(here, "index.html"),
    path.join(here, "manifest.json"),
  ]);
  console.log("Rendered 12 App Store PNGs, one marketing image, and gallery.");
} finally {
  await browser.close();
}
