import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import worker from "./index";

const env = {
  ASSETS: {
    fetch: async () =>
      new Response(
        await readFile(new URL("../index.html", import.meta.url), "utf-8"),
        {
          headers: { "Content-Type": "text/html", ETag: "static" },
        }
      ),
  },
};

describe("invite worker", () => {
  it("serves the application with personalized crawler metadata", async () => {
    const response = await worker.fetch(
      new Request("https://shouldertap.app/join?from=Jake&color=moss"),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    await expect(response.text()).resolves.toContain(
      "<title>Jake invited you · Shouldertap</title>"
    );
  });

  it("serves a PNG with bounded public caching", async () => {
    const response = await worker.fetch(
      new Request(
        "https://shouldertap.app/invite-card.png?from=Jake&color=moss"
      ),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.slice(0, 8)).toStrictEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    );
  });

  it("rejects arbitrary color strings before rendering", async () => {
    const response = await worker.fetch(
      new Request(
        "https://shouldertap.app/invite-card.png?from=Jake&color=red"
      ),
      env
    );
    expect([response.status, await response.text()]).toStrictEqual([
      404,
      "Card not found",
    ]);
  });
});
