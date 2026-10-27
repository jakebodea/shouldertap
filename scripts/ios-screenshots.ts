/* eslint-disable no-await-in-loop -- One request at a time: uploads land in listing order and stay under Apple's rate limits. */
/**
 * Replace an App Store version's iPhone screenshots with the exports from
 * brand/app-store (see its README), through the App Store Connect API.
 * `submit-ios.ts --screenshots` calls it for every localization.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Asc, AscResource } from "./submit-ios";

export interface Screenshot {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/** Screenshots in listing order, by App Store Connect display type. */
export type ScreenshotSets = Readonly<Record<string, readonly Screenshot[]>>;

/** One part of a file upload, as App Store Connect asks for it. */
export interface UploadPart {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

/** Sends a part to Apple's upload URL (not the API). A test passes a fake. */
export type Upload = (part: UploadPart) => Promise<void>;

interface UploadOperation {
  readonly method: string;
  readonly url: string;
  readonly offset: number;
  readonly length: number;
  readonly requestHeaders?: readonly { name: string; value: string }[];
}

interface DeliveryState {
  readonly state?: string;
  readonly errors?: readonly { description?: string }[];
}

// 1320 × 2868 fills the 6.9" slot (APP_IPHONE_67), 1206 × 2622 the 6.3" one (APP_IPHONE_61).
const DISPLAY_TYPES = {
  large: "APP_IPHONE_67",
  medium: "APP_IPHONE_61",
} as const;

/** The exports `brand/app-store/render.mjs` wrote, in its manifest's order. */
export const exportedScreenshots = (directory: string): ScreenshotSets => {
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "manifest.json"), "utf-8")
  ) as { screens: string[] };
  return Object.fromEntries(
    Object.entries(DISPLAY_TYPES).map(([size, displayType]) => [
      displayType,
      manifest.screens.map((screen) => {
        const fileName = `${screen}-${size}.png`;
        return {
          fileName,
          bytes: readFileSync(path.join(directory, "exports", fileName)),
        };
      }),
    ])
  );
};

const POLLS = 60;

const list = async (asc: Asc, route: string) => {
  const { data } = await asc("GET", route);
  if (!data) {
    return [];
  }
  return Array.isArray(data) ? data : [data as AscResource];
};

/** The localization's set for a display type, made if it's missing. */
const screenshotSet = async (
  asc: Asc,
  existing: readonly AscResource[],
  localizationId: string,
  displayType: string
) => {
  const found = existing.find(
    (s) => s.attributes?.screenshotDisplayType === displayType
  );
  if (found) {
    return found.id;
  }
  const { data } = await asc("POST", "/v1/appScreenshotSets", {
    data: {
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: localizationId },
        },
      },
    },
  });
  return (data as AscResource).id;
};

/** Reserve, upload and commit one image; returns its id. */
const uploadScreenshot = async (
  asc: Asc,
  upload: Upload,
  setId: string,
  { fileName, bytes }: Screenshot
) => {
  const { data } = await asc("POST", "/v1/appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName, fileSize: bytes.length },
      relationships: {
        appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
      },
    },
  });
  const reserved = data as AscResource;
  const operations = (reserved.attributes?.uploadOperations ??
    []) as readonly UploadOperation[];
  for (const operation of operations) {
    await upload({
      method: operation.method,
      url: operation.url,
      headers: Object.fromEntries(
        (operation.requestHeaders ?? []).map((h) => [h.name, h.value])
      ),
      bytes: bytes.subarray(
        operation.offset,
        operation.offset + operation.length
      ),
    });
  }
  await asc("PATCH", `/v1/appScreenshots/${reserved.id}`, {
    data: {
      type: "appScreenshots",
      id: reserved.id,
      attributes: {
        uploaded: true,
        sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
      },
    },
  });
  return reserved.id;
};

/** Apple checks each image before the version can be submitted. */
const delivered = async (
  asc: Asc,
  id: string,
  wait: (ms: number) => Promise<unknown>
) => {
  for (let poll = 0; poll < POLLS; poll += 1) {
    const [shot] = await list(asc, `/v1/appScreenshots/${id}`);
    const delivery = shot?.attributes?.assetDeliveryState as
      | DeliveryState
      | undefined;
    if (delivery?.state === "COMPLETE") {
      return;
    }
    if (delivery?.state === "FAILED") {
      const reasons = (delivery.errors ?? []).map((e) => e.description);
      throw new Error(`Apple rejected screenshot ${id}: ${reasons.join("; ")}`);
    }
    await wait(5000);
  }
  throw new Error(`Screenshot ${id} is still processing`);
};

export const replaceScreenshots = async (
  asc: Asc,
  upload: Upload,
  localizationId: string,
  sets: ScreenshotSets,
  wait: (ms: number) => Promise<unknown> = delay
) => {
  const existing = await list(
    asc,
    `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`
  );
  for (const [displayType, screenshots] of Object.entries(sets)) {
    const setId = await screenshotSet(
      asc,
      existing,
      localizationId,
      displayType
    );
    for (const old of await list(
      asc,
      `/v1/appScreenshotSets/${setId}/appScreenshots`
    )) {
      await asc("DELETE", `/v1/appScreenshots/${old.id}`);
    }
    const ids: string[] = [];
    for (const screenshot of screenshots) {
      ids.push(await uploadScreenshot(asc, upload, setId, screenshot));
    }
    await asc(
      "PATCH",
      `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`,
      { data: ids.map((id) => ({ type: "appScreenshots", id })) }
    );
    for (const id of ids) {
      await delivered(asc, id, wait);
    }
  }
};

/** Puts a part on Apple's upload URL. */
export const uploadPart: Upload = async ({ method, url, headers, bytes }) => {
  // Apple's operations are PUTs; the rule can't see that through the variable.
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options
  const response = await fetch(url, { method, headers, body: bytes });
  if (!response.ok) {
    throw new Error(`${method} upload → ${response.status}`);
  }
};
