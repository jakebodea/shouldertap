/**
 * Renders the link-preview cards: public/og-image.png for the site and
 * public/og-invite.png for invite links. Both are committed; rerun after
 * changing the copy, the mark or the palette:
 *
 *   bun run render:share-images
 *
 * The site card is the landing hero frozen on one tap, so a shared link looks
 * like the page it opens. The invite card can't name the inviter: the code
 * rides in the URL fragment, which link previews never see.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BubbleChatIcon,
  Clock01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { chromium } from "@playwright/test";
import { personColors, swatches } from "@shouldertap/domain";

const web = fileURLToPath(new URL("..", import.meta.url));
const font = await readFile(
  fileURLToPath(
    import.meta
      .resolve("@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2")
  )
);

const frame = swatches.cobalt;
const paper = "#f6f5f1";
const ink = "#161616";
const tone = "#6f6e69";
const line = "#dedcd5";

type Icon = typeof Tick02Icon;
const icon = (glyph: Icon) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75">${glyph
    .map(
      ([tag, attrs]) =>
        `<${tag} ${tag === "circle" ? `cx="${attrs.cx}" cy="${attrs.cy}" r="${attrs.r}"` : `d="${attrs.d}"`}/>`
    )
    .join("")}</svg>`;

// The same paths as components/mark.tsx.
const mark = (width: number) => `
  <svg viewBox="-2.5 -8.65 44.65 44.65" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:${width}px;height:${width}px">
    <path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/>
    <path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/>
    <path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/>
    <path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/>
  </svg>`;

const card = (content: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: "Bricolage";
    src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");
    font-weight: 200 800;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: ${frame.base}; color: ${ink};
    font-family: "Bricolage"; font-weight: 500; font-optical-sizing: auto;
  }
  header {
    height: 84px; padding: 0 56px; display: flex; align-items: center;
    color: ${frame.ink}; font-size: 30px; font-weight: 800; letter-spacing: -0.035em;
    gap: 0.32em;
  }
  header .url { margin-left: auto; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; opacity: 0.85; }
  main {
    position: absolute; left: 24px; right: 24px; top: 84px; bottom: 0;
    background: ${paper}; border-radius: 30px 30px 0 0;
    padding: 40px 56px 0; display: flex; flex-direction: column; gap: 24px;
  }
  .who { display: flex; align-items: center; gap: 12px; font-size: 24px; font-weight: 600; color: ${tone}; }
  .who i {
    width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center;
    background: ${frame.base}; color: ${frame.ink}; font-style: normal; font-weight: 700; font-size: 17px;
  }
  .who b { color: ${ink}; font-weight: 700; }
  h1 { font-size: 132px; line-height: 0.92; font-weight: 800; letter-spacing: -0.045em; }
  .replies { display: flex; gap: 14px; }
  .pill {
    height: 64px; padding: 0 28px; border-radius: 999px; display: inline-flex; align-items: center; gap: 12px;
    font-size: 25px; font-weight: 700; box-shadow: inset 0 0 0 1.5px ${line};
  }
  .pill svg { width: 26px; height: 26px; }
  .pill.fill { background: ${frame.base}; color: ${frame.ink}; box-shadow: none; }
  footer {
    margin-top: auto; padding: 22px 0 28px; border-top: 1.5px solid ${line};
    font-size: 30px; font-weight: 700; line-height: 1.15; letter-spacing: -0.025em;
  }
  footer span { color: ${tone}; }
  .lead { font-size: 38px; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em; color: ${tone}; max-width: 22em; }
  .swatches { display: flex; gap: 18px; margin-top: 22px; }
  .swatches i { width: 80px; height: 80px; border-radius: 50%; display: grid; place-items: center; }
  .swatches svg { width: 38px; height: 38px; stroke-width: 2.25; }
</style></head><body>
  <header>${mark(31)}Shouldertap<span class="url">shouldertap.app</span></header>
  <main>${content}</main>
</body></html>`;

const site = card(`
  <p class="who"><i>A</i><b>Alex</b><span>just now</span></p>
  <h1>Can you come here?</h1>
  <div class="replies">
    <span class="pill fill">${icon(Tick02Icon)}On it</span>
    <span class="pill">${icon(Clock01Icon)}In 10 min</span>
    <span class="pill">${icon(BubbleChatIcon)}Reply</span>
  </div>
  <footer>Their message covers your Mac until you answer.</footer>`);

// The join page's color picker, with the default color chosen.
const invite = card(`
  <h1>You're invited</h1>
  <p class="lead">Pair your iPhone to tap them on the shoulder. Pick a color so they know it's you.</p>
  <div class="swatches">${personColors
    .map(
      (color) =>
        `<i style="background:${swatches[color].base};color:${swatches[color].ink}">${color === "cobalt" ? icon(Tick02Icon) : ""}</i>`
    )
    .join("")}</div>
  <footer>Your taps cover their Mac until they answer. <span>Nothing to install.</span></footer>`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
  });
  // One page renders each card in turn.
  /* oxlint-disable no-await-in-loop */
  for (const [html, file] of [
    [site, "og-image.png"],
    [invite, "og-invite.png"],
  ] as const) {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${web}public/${file}` });
  }
  /* oxlint-enable no-await-in-loop */
} finally {
  await browser.close();
}
