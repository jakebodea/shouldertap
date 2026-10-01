import { expect, type Page, test } from "@playwright/test";

const scenes = [
  { color: "rgb(31, 90, 61)", hex: "#1f5a3d", message: "Dinner's ready" },
  { color: "rgb(35, 64, 200)", hex: "#2340c8", message: "Can you come here?" },
  { color: "rgb(242, 196, 189)", hex: "#f2c4bd", message: "Call me" },
  { color: "rgb(232, 176, 34)", hex: "#e8b022", message: "Take out the trash" },
] as const;
const DOWNLOAD_PATH = /\/download$/;
const RADIAL_GRADIENT = /radial-gradient/;

async function expectFrame(page: Page, scene: (typeof scenes)[number]) {
  await expect(page.locator("h2[aria-live]")).toContainText(scene.message);
  const frame = page.locator(".landing-frame");
  // Safari's native UI is outside Playwright's screenshots. Verify all of its
  // color sources. A fixed shell caches its initial tint on iOS Safari 26.
  await expect(frame).toHaveCSS("position", "absolute");
  await expect(frame).toHaveCSS("background-color", scene.color);
  await expect(frame).toHaveCSS("background-image", "none");
  await expect(page.locator("html")).toHaveCSS("background-color", scene.color);
  await expect(page.locator("body")).toHaveCSS("background-color", scene.color);
  const metas = page.locator('meta[name="theme-color"]');
  await expect(metas).toHaveCount(2);
  await expect(metas.nth(0)).toHaveAttribute("content", scene.hex);
  await expect(metas.nth(1)).toHaveAttribute("content", scene.hex);
  const bounds = await frame.boundingBox();
  expect(bounds).toEqual({ x: 0, y: 0, ...page.viewportSize() });
}

test("every reply transition updates both document edges and wraps to moss", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expectFrame(page, scenes[0]);
  for (const scene of [...scenes.slice(1), scenes[0]]) {
    // biome-ignore lint/performance/noAwaitInLoops: each scene depends on the previous transition.
    await page.getByRole("button", { name: "On it", exact: true }).tap();
    await expectFrame(page, scene);
    // Wait for the actual wipe, then verify the rendered fill has settled too.
    await expect
      .poll(() =>
        page
          .locator(".landing-frame")
          .evaluate((frame) =>
            getComputedStyle(frame).getPropertyValue("--wipe-from").trim()
          )
      )
      .toBe(scene.hex);
    await expect(page.locator(".wipe-edge-top")).toHaveCSS(
      "background-color",
      scene.color
    );
    await expect(page.locator(".wipe-edge-bottom")).toHaveCSS(
      "background-color",
      scene.color
    );
    await testInfo.attach(`frame-${scene.hex.slice(1)}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
});

test("automatic transition updates the canvas without an intermediate reset", async ({
  page,
}) => {
  await page.goto("/");
  await expectFrame(page, scenes[0]);
  await page.evaluate(() => {
    const colors: {
      element: string;
      previous: string | null;
      color: string;
    }[] = [];
    Object.assign(window, { canvasColors: colors });
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        if (target === document.documentElement || target === document.body) {
          colors.push({
            element: target.tagName,
            previous: record.oldValue,
            color: target.style.backgroundColor,
          });
        }
      }
    }).observe(document.documentElement, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["style"],
      subtree: true,
    });
  });
  await expect(page.locator(".landing-frame")).toHaveCSS(
    "background-color",
    scenes[1].color,
    { timeout: 10_000 }
  );
  await expectFrame(page, scenes[1]);
  const colors = await page.evaluate(() => Reflect.get(window, "canvasColors"));
  expect(colors).toHaveLength(2);
  expect(colors).toEqual(
    expect.arrayContaining([
      {
        element: "HTML",
        previous: expect.stringContaining(scenes[0].color),
        color: scenes[1].color,
      },
      {
        element: "BODY",
        previous: expect.stringContaining(scenes[0].color),
        color: scenes[1].color,
      },
    ])
  );
});

test("the color sources stay current halfway through the animated wipe", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expectFrame(page, scenes[0]);
  await page.keyboard.press("1");
  await page.locator(".landing-frame").evaluate((frame) => {
    for (const animation of frame.getAnimations()) {
      animation.pause();
      animation.currentTime = 350;
    }
  });
  await expectFrame(page, scenes[1]);
  const wipe = page.locator(".landing-frame > .frame-fill");
  await expect(wipe).toHaveCSS("position", "absolute");
  await expect(wipe).toHaveCSS("background-color", scenes[1].color);
  await expect(wipe).toHaveCSS("background-image", RADIAL_GRADIENT);
  const radius = await wipe.evaluate((layer) =>
    Number.parseFloat(getComputedStyle(layer).getPropertyValue("--wipe"))
  );
  expect(radius).toBeGreaterThan(0);
  await testInfo.attach("mid-transition", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("browser edge tints follow the same paused circle, top before bottom", async ({
  page,
}) => {
  await page.goto("/");
  await expectFrame(page, scenes[0]);
  await page.keyboard.press("1");
  await page.locator(".landing-frame").evaluate((frame) => {
    const [animation] = frame.getAnimations();
    if (!animation) {
      throw new Error("Missing wipe animation");
    }
    animation.pause();
    animation.currentTime = 250;
  });
  const edges = await page.locator(".landing-frame").evaluate((frame) => {
    const radius = Number.parseFloat(
      getComputedStyle(frame).getPropertyValue("--wipe")
    );
    const { width, height } = frame.getBoundingClientRect();
    const colorAt = (y: number) => {
      const coverage =
        radius <= y ? 0 : Math.min(1, Math.sqrt(radius ** 2 - y ** 2) / width);
      const from = [31, 90, 61];
      const to = [35, 64, 200];
      return `rgb(${from.map((channel, i) => Math.round(channel + ((to[i] ?? 0) - channel) * coverage)).join(", ")})`;
    };
    return { top: colorAt(0), bottom: colorAt(height), radius, height };
  });
  expect(edges.radius).toBeGreaterThan(0);
  expect(edges.radius).toBeLessThan(edges.height);
  expect(edges.top).not.toBe(scenes[0].color);
  expect(edges.top).not.toBe(scenes[1].color);
  expect(edges.bottom).toBe(scenes[0].color);
  await expect(page.locator(".wipe-edge-top")).toHaveCSS(
    "background-color",
    edges.top
  );
  await expect(page.locator(".wipe-edge-bottom")).toHaveCSS(
    "background-color",
    edges.bottom
  );
  // A separate 700ms timer would keep changing even though the wipe is paused.
  await page.waitForTimeout(800);
  await expect(page.locator(".wipe-edge-top")).toHaveCSS(
    "background-color",
    edges.top
  );
  await page.locator(".landing-frame").evaluate((frame) => {
    frame.getAnimations()[0]?.play();
  });
  await expect(page.locator(".wipe-edge-bottom")).toHaveCSS(
    "background-color",
    scenes[1].color
  );
});

test("rapid replies and viewport changes keep the latest edge color", async ({
  page,
}) => {
  await page.goto("/");
  await expectFrame(page, scenes[0]);
  for (const scene of scenes.slice(1)) {
    // biome-ignore lint/performance/noAwaitInLoops: rapid replies must advance sequentially.
    await page.keyboard.press("1");
    await expectFrame(page, scene);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await expectFrame(page, scenes[3]);
  await page.setViewportSize({ width: 390, height: 600 });
  await expectFrame(page, scenes[3]);
  await expect(page.locator(".wipe-edge-bottom")).toHaveCSS(
    "background-color",
    scenes[3].color
  );
});

test("reduced motion updates edges immediately and navigation gets the new frame", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expectFrame(page, scenes[0]);
  for (const scene of scenes.slice(1)) {
    // biome-ignore lint/performance/noAwaitInLoops: verify each reduced-motion scene in order.
    await page.getByRole("button", { name: "On it", exact: true }).tap();
    await expectFrame(page, scene);
    await expect(page.locator(".landing-frame")).toHaveCSS(
      "--wipe-from",
      scene.hex
    );
  }
  await page.getByRole("link", { name: "Download", exact: true }).click();
  await expect(page).toHaveURL(DOWNLOAD_PATH);
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    scenes[0].color
  );
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    scenes[0].color
  );
  await page.getByRole("link", { name: "Shouldertap home" }).click();
  await expectFrame(page, scenes[0]);
});
