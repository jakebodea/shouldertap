/**
 * Set the App Store promotional text through the App Store Connect API. Apple
 * lets it change at any time, even on a live version or one in review, so it
 * goes on every version that is live or on its way. The text defaults to the
 * "Promotional text" section of brand/app-store/listing-copy.md.
 * `.github/workflows/ios-promo-text.yml` runs it on demand.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8="$(cat AuthKey.p8)" \
 *     bun scripts/ios-promo-text.ts [--text "…"]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { BUNDLE_ID, connect } from "./submit-ios";
import type { Asc, AscDocument, AscResource } from "./submit-ios";

/** Apple's limit for the field. */
const MAX_LENGTH = 170;

/** Versions people see now or will see next; older ones are replaced. */
const CURRENT_STATES = new Set([
  "READY_FOR_SALE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_APP_STORE",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
]);

const resources = ({ data }: AscDocument): readonly AscResource[] => {
  if (!data) {
    return [];
  }
  return Array.isArray(data) ? data : [data as AscResource];
};

/** The paragraph under "## Promotional text" in a listing-copy file. */
export const listedPromoText = (markdown: string) => {
  const match = /^## Promotional text\s*\n+(?<text>[^\n#][^\n]*)/mu.exec(
    markdown
  );
  const text = match?.groups?.text?.trim();
  if (!text) {
    throw new Error('No "## Promotional text" section');
  }
  return text;
};

/** Sets the text on each current version's localizations; returns them. */
export const setPromoText = async (asc: Asc, text: string) => {
  if (text.length > MAX_LENGTH) {
    throw new Error(
      `Promotional text is ${text.length} characters; Apple allows ${MAX_LENGTH}`
    );
  }
  const list = async (path: string) => resources(await asc("GET", path));
  const [app] = await list(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`
  );
  if (!app) {
    throw new Error(`No app with bundle id ${BUNDLE_ID}`);
  }
  const all = await list(
    `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=50`
  );
  const versions = all.filter((v) =>
    CURRENT_STATES.has(String(v.attributes?.appStoreState))
  );
  const updated = await Promise.all(
    versions.map(async (version) => {
      const localizations = await list(
        `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`
      );
      await Promise.all(
        localizations.map((localization) =>
          asc("PATCH", `/v1/appStoreVersionLocalizations/${localization.id}`, {
            data: {
              type: "appStoreVersionLocalizations",
              id: localization.id,
              attributes: { promotionalText: text },
            },
          })
        )
      );
      return `${String(version.attributes?.versionString)} (${String(version.attributes?.appStoreState)}, ${localizations.length} languages)`;
    })
  );
  if (updated.length === 0) {
    throw new Error("No live or pending App Store version");
  }
  return updated;
};

if (import.meta.main) {
  const { values } = parseArgs({ options: { text: { type: "string" } } });
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 } = process.env;
  if (!(ASC_KEY_ID && ASC_ISSUER_ID && ASC_KEY_P8)) {
    throw new Error("Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8");
  }
  const text =
    values.text ||
    listedPromoText(readFileSync("brand/app-store/listing-copy.md", "utf-8"));
  const asc = await connect({
    id: ASC_KEY_ID,
    issuer: ASC_ISSUER_ID,
    p8: ASC_KEY_P8,
  });
  for (const line of await setPromoText(asc, text)) {
    console.log(`==> Promotional text set on ${line}`);
  }
}
