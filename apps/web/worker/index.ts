import { Resvg } from "@cf-wasm/resvg";

import fontUrl from "../../macos/Resources/Fonts/BricolageGrotesque-ExtraBold.ttf?inline";
import {
  cardPerson,
  escapeMarkup,
  inviteNameLines,
  inviteCardSvg,
  personalizeInviteHtml,
} from "./invite-card";

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const font = Uint8Array.from(
  atob(fontUrl.split(",")[1]),
  (char) => char.codePointAt(0) ?? 0
);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/invite-card.png") {
      const person = cardPerson(url);
      if (!person) {
        return new Response("Card not found", { status: 404 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      const options = { font: { fontBuffers: [font], loadSystemFonts: false } };
      const lines = inviteNameLines(person.name);
      // Measure the actual typeface so wide letters and long names stay on paper.
      const measurement = await Resvg.async(
        `<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="400"><g font-family="Bricolage Grotesque" font-weight="800" font-size="100">${lines.map((line, index) => `<text x="0" y="${100 + index * 120}">${escapeMarkup(line)}</text>`).join("")}</g></svg>`,
        options
      );
      let nameSize: number;
      try {
        const width = measurement.getBBox()?.width ?? 1040;
        nameSize = Math.min(
          lines.length > 1 ? 82 : 100,
          (100 * 1030) / Math.max(width, 1)
        );
      } finally {
        measurement.free();
      }
      const renderer = await Resvg.async(
        inviteCardSvg(person, nameSize),
        options
      );
      try {
        const rendered = renderer.render();
        try {
          return new Response(
            request.method === "HEAD" ? null : new Uint8Array(rendered.asPng()),
            {
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=86400",
                "X-Content-Type-Options": "nosniff",
              },
            }
          );
        } finally {
          rendered.free();
        }
      } finally {
        renderer.free();
      }
    }
    const response = await env.ASSETS.fetch(request);
    if (
      url.pathname !== "/join" ||
      !cardPerson(url) ||
      !response.headers.get("content-type")?.includes("text/html")
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(personalizeInviteHtml(await response.text(), url), {
      status: response.status,
      headers,
    });
  },
};
