import { describe, expect, it } from "vitest";

import { listedPromoText, setPromoText } from "./ios-promo-text";
import type { Asc } from "./submit-ios";

/**
 * One app with an old replaced version, the live 0.2.1 and 0.3.0 in review,
 * each with an English and a French localization.
 */
const fakeAsc = () => {
  const versions = [
    { id: "v020", versionString: "0.2.0", state: "REPLACED_WITH_NEW_VERSION" },
    { id: "v021", versionString: "0.2.1", state: "READY_FOR_SALE" },
    { id: "v030", versionString: "0.3.0", state: "WAITING_FOR_REVIEW" },
  ];
  const promo = new Map<string, string>();
  const asc: Asc = (method, route, body) => {
    const url = new URL(route, "https://asc.test");
    const path = url.pathname;
    if (method === "GET" && path === "/v1/apps") {
      const ours =
        url.searchParams.get("filter[bundleId]") === "app.shouldertap.iphone";
      return Promise.resolve({ data: ours ? [{ id: "app1" }] : [] });
    }
    if (method === "GET" && path === "/v1/apps/app1/appStoreVersions") {
      return Promise.resolve({
        data: versions.map((v) => ({
          id: v.id,
          attributes: {
            versionString: v.versionString,
            appStoreState: v.state,
          },
        })),
      });
    }
    const localizations =
      /^\/v1\/appStoreVersions\/(?<id>\w+)\/appStoreVersionLocalizations$/u.exec(
        path
      );
    if (method === "GET" && localizations) {
      const id = localizations.groups?.id;
      return Promise.resolve({
        data: [{ id: `${id}-en` }, { id: `${id}-fr` }],
      });
    }
    const localization =
      /^\/v1\/appStoreVersionLocalizations\/(?<id>[\w-]+)$/u.exec(path);
    if (method === "PATCH" && localization) {
      const { data } = body as {
        data: { attributes: { promotionalText: string } };
      };
      promo.set(localization.groups?.id ?? "", data.attributes.promotionalText);
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`Unexpected ${method} ${route}`));
  };
  return { asc, promo };
};

describe("setting the App Store promotional text", () => {
  it("sets it on the live version and the one in review, in every language", async () => {
    const { asc, promo } = fakeAsc();
    const updated = await setPromoText(asc, "Tap someone.");
    expect(updated).toStrictEqual([
      "0.2.1 (READY_FOR_SALE, 2 languages)",
      "0.3.0 (WAITING_FOR_REVIEW, 2 languages)",
    ]);
    expect(Object.fromEntries(promo)).toStrictEqual({
      "v021-en": "Tap someone.",
      "v021-fr": "Tap someone.",
      "v030-en": "Tap someone.",
      "v030-fr": "Tap someone.",
    });
  });

  it("refuses text longer than Apple's 170 characters", async () => {
    const { asc } = fakeAsc();
    await expect(setPromoText(asc, "a".repeat(171))).rejects.toThrow(
      "Promotional text is 171 characters; Apple allows 170"
    );
  });

  it("reads the text from the listing copy", () => {
    const markdown =
      "# Listing\n\n## Subtitle\n\nA little tap.\n\n## Promotional text\n\nSend a little tap.\n\n## Description\n\nMore.\n";
    expect(listedPromoText(markdown)).toBe("Send a little tap.");
  });
});
