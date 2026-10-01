import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const INVITE_DESCRIPTION =
  "Pair your iPhone to tap them on the shoulder. Your taps cover their Mac until they answer. Nothing to install.";

/** Swaps a tag's content in index.html, whose meta tags list content first. */
const meta = (attribute: string, content: string) =>
  [
    new RegExp(`(<meta\\s+content=")[^"]*("\\s+${attribute})`),
    `$1${content}$2`,
  ] as const;

const INVITE_SWAPS = [
  [/<title>[^<]*<\/title>/, "<title>You're invited · Shouldertap</title>"],
  meta('name="description"', INVITE_DESCRIPTION),
  meta('property="og:title"', "You're invited to Shouldertap"),
  meta('property="og:description"', INVITE_DESCRIPTION),
  meta('property="og:url"', "https://shouldertap.app/join"),
  meta('property="og:image"', "https://shouldertap.app/og-invite.png"),
  meta(
    'property="og:image:alt"',
    "You're invited: pick a color and pair your iPhone to tap them on the shoulder."
  ),
] as const;

/**
 * Invite links (`/join#<code>`) are shared over iMessage and Slack, whose
 * previews read static HTML. Emit `join.html` with the invite card so the
 * asset server answers `/join` with it; the app itself is the same bundle.
 * The code stays in the fragment, so the card can't name who sent it.
 */
const inviteHtml = (): Plugin => ({
  name: "shouldertap:invite-html",
  apply: "build",
  // After Vite emits index.html.
  enforce: "post",
  generateBundle(_, bundle) {
    const index = bundle["index.html"];
    if (index?.type !== "asset" || typeof index.source !== "string") {
      throw new Error("invite-html: index.html is missing from the bundle");
    }
    let html = index.source;
    for (const [pattern, replacement] of INVITE_SWAPS) {
      if (!pattern.test(html)) {
        throw new Error(`invite-html: no match for ${pattern}`);
      }
      html = html.replace(pattern, replacement);
    }
    this.emitFile({ type: "asset", fileName: "join.html", source: html });
  },
});

export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    inviteHtml(),
  ],
});
