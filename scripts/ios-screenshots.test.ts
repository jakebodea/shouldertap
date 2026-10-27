import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { replaceScreenshots } from "./ios-screenshots";
import type { Upload } from "./ios-screenshots";
import type { Asc, AscDocument } from "./submit-ios";

interface Shot {
  id: string;
  fileName: string;
  received: number[];
  checksum?: string;
  polls: number;
}

interface ScreenshotSet {
  id: string;
  type: string;
  shots: string[];
}

/** The resource a POST or PATCH sends. */
interface Sent {
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data: { id: string } }>;
}

type Handler = (id: string, raw: unknown) => AscDocument;

const sentOf = (raw: unknown): Sent =>
  (raw as { data?: Sent } | undefined)?.data ?? {};

/** Apple marks an image COMPLETE on the second poll if it arrived whole. */
const deliveryOf = (shot: Shot) => {
  shot.polls += 1;
  const intact =
    !shot.received.includes(-1) &&
    shot.checksum ===
      createHash("md5").update(Uint8Array.from(shot.received)).digest("hex");
  if (shot.polls < 2) {
    return { state: "UPLOAD_COMPLETE", errors: [] };
  }
  return intact
    ? { state: "COMPLETE", errors: [] }
    : { state: "FAILED", errors: [{ description: "Image is corrupt." }] };
};

/**
 * App Store Connect's screenshot routes for one localization that already
 * has an old 6.3" screenshot. Uploads arrive in two parts.
 */
const fakeAsc = () => {
  const shots = new Map<string, Shot>([
    ["old1", { id: "old1", fileName: "old.png", received: [], polls: 0 }],
  ]);
  const sets: ScreenshotSet[] = [
    { id: "set61", type: "APP_IPHONE_61", shots: ["old1"] },
  ];
  const deleted: string[] = [];
  const setWith = (id: string) => sets.find((s) => s.id === id);

  const reserve: Handler = (_id, raw) => {
    const { attributes, relationships } = sentOf(raw);
    const id = `shot${shots.size}`;
    const size = Number(attributes?.fileSize);
    shots.set(id, {
      id,
      fileName: String(attributes?.fileName),
      received: Array.from({ length: size }, () => -1),
      polls: 0,
    });
    setWith(relationships?.appScreenshotSet?.data.id ?? "")?.shots.push(id);
    const half = Math.ceil(size / 2);
    const part = (offset: number, length: number) => ({
      method: "PUT",
      url: `https://upload.test/${id}/${offset}`,
      offset,
      length,
      requestHeaders: [{ name: "Content-Type", value: "image/png" }],
    });
    return {
      data: {
        id,
        attributes: {
          uploadOperations: [part(0, half), part(half, size - half)],
        },
      },
    };
  };

  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/v1\/appStoreVersionLocalizations\/loc1\/appScreenshotSets$/u,
      () => ({
        data: sets.map((s) => ({
          id: s.id,
          attributes: { screenshotDisplayType: s.type },
        })),
      }),
    ],
    [
      "POST",
      /^\/v1\/appScreenshotSets$/u,
      (_id, raw) => {
        const set = {
          id: `set${sets.length}`,
          type: String(sentOf(raw).attributes?.screenshotDisplayType),
          shots: [],
        };
        sets.push(set);
        return { data: { id: set.id } };
      },
    ],
    [
      "GET",
      /^\/v1\/appScreenshotSets\/(?<id>[^/]+)\/appScreenshots$/u,
      (id) => ({ data: (setWith(id)?.shots ?? []).map((s) => ({ id: s })) }),
    ],
    [
      "PATCH",
      /^\/v1\/appScreenshotSets\/(?<id>[^/]+)\/relationships\/appScreenshots$/u,
      (id, raw) => {
        const set = setWith(id);
        if (set) {
          set.shots = (raw as { data: { id: string }[] }).data.map((d) => d.id);
        }
        return {};
      },
    ],
    ["POST", /^\/v1\/appScreenshots$/u, reserve],
    [
      "DELETE",
      /^\/v1\/appScreenshots\/(?<id>[^/]+)$/u,
      (id) => {
        deleted.push(id);
        for (const set of sets) {
          set.shots = set.shots.filter((s) => s !== id);
        }
        return {};
      },
    ],
    [
      "PATCH",
      /^\/v1\/appScreenshots\/(?<id>[^/]+)$/u,
      (id, raw) => {
        const shot = shots.get(id);
        const { attributes } = sentOf(raw);
        if (shot && attributes?.uploaded === true) {
          shot.checksum = String(attributes.sourceFileChecksum);
        }
        return {};
      },
    ],
    [
      "GET",
      /^\/v1\/appScreenshots\/(?<id>[^/]+)$/u,
      (id) => {
        const shot = shots.get(id);
        return shot
          ? {
              data: {
                id,
                attributes: { assetDeliveryState: deliveryOf(shot) },
              },
            }
          : {};
      },
    ],
  ];

  const asc: Asc = (method, route, raw) => {
    for (const [m, pattern, handle] of routes) {
      const match = pattern.exec(route);
      if (m === method && match) {
        return Promise.resolve(handle(match.groups?.id ?? "", raw));
      }
    }
    return Promise.reject(new Error(`Unexpected ${method} ${route}`));
  };

  const upload: Upload = ({ url, bytes }) => {
    const { pathname } = new URL(url);
    const [id = "", offset = "0"] = pathname.split("/").slice(1);
    const shot = shots.get(id);
    for (const [i, byte] of bytes.entries()) {
      if (shot) {
        shot.received[Number(offset) + i] = byte;
      }
    }
    return Promise.resolve();
  };

  /** "file text" for each image in each display type's set, in listing order. */
  const listing = () =>
    Object.fromEntries(
      sets.map((s) => [
        s.type,
        s.shots.map((id) => {
          const shot = shots.get(id);
          const text = Buffer.from(
            Uint8Array.from(shot?.received ?? [])
          ).toString();
          return `${shot?.fileName} ${text}`;
        }),
      ])
    );
  return { asc, upload, listing, deleted, shots };
};

const file = (fileName: string, text: string) => ({
  fileName,
  bytes: new TextEncoder().encode(text),
});

const noWait = () => Promise.resolve();
const dropParts: Upload = () => Promise.resolve();

describe("replacing the App Store screenshots", () => {
  it("swaps the old images for the new ones, in order, for each size", async () => {
    const { asc, upload, listing, deleted, shots } = fakeAsc();
    await replaceScreenshots(
      asc,
      upload,
      "loc1",
      {
        APP_IPHONE_67: [
          file("01-large.png", "abc"),
          file("02-large.png", "hello"),
        ],
        APP_IPHONE_61: [
          file("01-medium.png", "xyz"),
          file("02-medium.png", "world"),
        ],
      },
      noWait
    );
    expect(deleted).toStrictEqual(["old1"]);
    expect(listing()).toStrictEqual({
      APP_IPHONE_61: ["01-medium.png xyz", "02-medium.png world"],
      APP_IPHONE_67: ["01-large.png abc", "02-large.png hello"],
    });
    // MD5 of "abc", from RFC 1321's test suite.
    const first = [...shots.values()].find(
      (s) => s.fileName === "01-large.png"
    );
    expect(first?.checksum).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("stops when Apple rejects an image", async () => {
    const { asc } = fakeAsc();
    await expect(
      replaceScreenshots(
        asc,
        dropParts,
        "loc1",
        { APP_IPHONE_61: [file("01-medium.png", "xyz")] },
        noWait
      )
    ).rejects.toThrow("Apple rejected screenshot shot1: Image is corrupt.");
  });
});
