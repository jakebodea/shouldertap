import { readFile } from "node:fs/promises";

import { Resvg } from "@cf-wasm/resvg";
import { describe, expect, it } from "vitest";

import {
  cardPerson,
  inviteCardSvg,
  inviteNameLines,
  personalizeInviteHtml,
} from "./invite-card";

const url = new URL(
  "https://shouldertap.app/join?from=Jake+%26+Ana&color=moss#inbox.id.secret"
);

describe("personalized invite previews", () => {
  it("rewrites crawler-visible metadata without leaking the pairing secret", async () => {
    const html = await readFile(
      new URL("../index.html", import.meta.url),
      "utf-8"
    );
    const personalized = personalizeInviteHtml(html, url);
    expect(personalized).toContain(
      "<title>Jake &amp; Ana invited you · Shouldertap</title>"
    );
    expect(personalized).toContain(
      'content="https://shouldertap.app/invite-card.png?from=Jake+%26+Ana&amp;color=moss" property="og:image"'
    );
    expect(personalized).toContain(
      'content="https://shouldertap.app/join?from=Jake+%26+Ana&amp;color=moss" property="og:url"'
    );
    expect(personalized).not.toContain("secret");
    expect(personalized).toContain('<div id="app"></div>');
  });

  it("treats names as text in both HTML and SVG", () => {
    const hostile = new URL("https://shouldertap.app/join");
    hostile.searchParams.set("from", '<script>"$&</script>');
    hostile.searchParams.set("color", "rose");
    const person = cardPerson(hostile);
    if (!person) {
      throw new Error("Valid card rejected");
    }
    expect(inviteCardSvg(person)).toContain(
      "&lt;script&gt;&quot;$&amp;&lt;/script&gt;"
    );
    expect(personalizeInviteHtml("<title>Invite</title>", hostile)).toBe(
      "<title>&lt;script&gt;&quot;$&amp;&lt;/script&gt; invited you · Shouldertap</title>"
    );
  });

  it("leaves legacy and invalid links on the generic preview", () => {
    for (const query of [
      "",
      "?from=Jake",
      "?from=Jake&color=red",
      "?from=Jake%00&color=moss",
      `?from=${"J".repeat(41)}&color=moss`,
    ]) {
      expect(
        personalizeInviteHtml(
          "<title>You're invited</title>",
          new URL(`https://shouldertap.app/join${query}`)
        )
      ).toBe("<title>You're invited</title>");
    }
  });

  it("wraps long names at word boundaries", () => {
    expect(
      inviteNameLines("Alexandria-Josephine Montgomery-Williams")
    ).toStrictEqual(["Alexandria-Josephine", "Montgomery-Williams"]);
  });

  it("renders a real 1200 × 630 PNG using the bundled typeface", async () => {
    const font = await readFile(
      new URL(
        "../../macos/Resources/Fonts/BricolageGrotesque-ExtraBold.ttf",
        import.meta.url
      )
    );
    const svg = inviteCardSvg({ name: "Jake", color: "moss" });
    expect(svg).toContain('fill="#1f5a3d"');
    expect(svg).toContain(">Jake</text>");
    const renderer = await Resvg.async(svg, {
      font: { fontBuffers: [font], loadSystemFonts: false },
    });
    try {
      const rendered = renderer.render();
      try {
        const png = rendered.asPng();
        expect(png.slice(0, 8)).toStrictEqual(
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
        );
        expect([rendered.width, rendered.height]).toStrictEqual([1200, 630]);
      } finally {
        rendered.free();
      }
    } finally {
      renderer.free();
    }
  });
});
