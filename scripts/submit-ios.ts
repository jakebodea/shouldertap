/**
 * Submit an uploaded iOS build for App Review through the App Store Connect
 * API: make (or reuse) the App Store version, attach the build, set What's
 * New, optionally replace the screenshots with brand/app-store's exports,
 * then submit. `.github/workflows/submit-ios.yml` runs it on demand.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8="$(cat AuthKey.p8)" \
 *     bun scripts/submit-ios.ts --version 0.2.1 --build 11 \
 *       --whats-new "…" [--release after-approval|manual] \
 *       [--screenshots brand/app-store] [--no-submit]
 *
 * Safe to rerun: each step finds what an earlier run made before making it.
 */
import { parseArgs } from "node:util";

import {
  exportedScreenshots,
  replaceScreenshots,
  uploadPart,
} from "./ios-screenshots";
import type { ScreenshotSets, Upload } from "./ios-screenshots";

const API = "https://api.appstoreconnect.apple.com";
export const BUNDLE_ID = "app.shouldertap.iphone";

export interface SubmitOptions {
  readonly version: string;
  readonly build: string;
  readonly whatsNew: string;
  /** After approval it goes live by itself; manual waits for a click. */
  readonly release: "after-approval" | "manual";
  /** Replaces every localization's iPhone screenshots when set. */
  readonly screenshots?: ScreenshotSets;
  /** False prepares the version without submitting it. */
  readonly submit?: boolean;
}

/** A JSON:API resource as App Store Connect returns it. */
export interface AscResource {
  readonly id: string;
  readonly attributes?: Record<string, unknown>;
  readonly relationships?: Record<
    string,
    { readonly data?: { readonly id: string } | null }
  >;
}

export interface AscDocument {
  readonly data?: AscResource | readonly AscResource[];
}

/** The API, authenticated. A test passes a fake. */
export type Asc = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
) => Promise<AscDocument>;

const log = (line: string) => console.log(`==> ${line}`);

/** Versions in these states can't take a new build or be submitted again. */
const LOCKED_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_DEVELOPER_RELEASE",
  "READY_FOR_SALE",
  "PROCESSING_FOR_APP_STORE",
]);

const resources = (document: AscDocument): readonly AscResource[] => {
  if (!document.data) {
    return [];
  }
  return Array.isArray(document.data) ? document.data : [document.data];
};

export const submitForReview = async (
  asc: Asc,
  options: SubmitOptions,
  upload: Upload = uploadPart
) => {
  const list = async (path: string) => resources(await asc("GET", path));
  const create = async (path: string, body: unknown) => {
    const [made] = resources(await asc("POST", path, body));
    if (!made) {
      throw new Error(`POST ${path} returned nothing`);
    }
    return made;
  };

  const [app] = await list(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`
  );
  if (!app) {
    throw new Error(`No app with bundle id ${BUNDLE_ID}`);
  }

  const [build] = await list(
    `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(options.build)}&filter[preReleaseVersion.version]=${encodeURIComponent(options.version)}&filter[preReleaseVersion.platform]=IOS`
  );
  if (!build) {
    throw new Error(
      `No build ${options.version} (${options.build}) in App Store Connect yet`
    );
  }
  const processing = build.attributes?.processingState;
  if (processing !== "VALID") {
    throw new Error(
      `Build ${options.version} (${options.build}) is ${String(processing)}, not VALID yet`
    );
  }

  const releaseType =
    options.release === "manual" ? "MANUAL" : "AFTER_APPROVAL";
  const [existing] = await list(
    `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${encodeURIComponent(options.version)}`
  );
  let version = existing;
  if (version) {
    const state = String(version.attributes?.appStoreState);
    if (LOCKED_STATES.has(state)) {
      throw new Error(`Version ${options.version} is already ${state}`);
    }
    log(`Using App Store version ${options.version} (${state})`);
    await asc("PATCH", `/v1/appStoreVersions/${version.id}`, {
      data: {
        type: "appStoreVersions",
        id: version.id,
        attributes: { releaseType },
      },
    });
  } else {
    log(`Creating App Store version ${options.version}`);
    version = await create("/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: {
          platform: "IOS",
          versionString: options.version,
          releaseType,
        },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
  }
  const versionId = version.id;

  log(`Attaching build ${options.build}`);
  await asc("PATCH", `/v1/appStoreVersions/${versionId}/relationships/build`, {
    data: { type: "builds", id: build.id },
  });

  const localizations = await list(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`
  );
  if (localizations.length === 0) {
    throw new Error(`Version ${options.version} has no localizations`);
  }
  log(`Setting What's New (${localizations.length} languages)`);
  await Promise.all(
    localizations.map((localization) =>
      asc("PATCH", `/v1/appStoreVersionLocalizations/${localization.id}`, {
        data: {
          type: "appStoreVersionLocalizations",
          id: localization.id,
          attributes: { whatsNew: options.whatsNew },
        },
      })
    )
  );

  const { screenshots } = options;
  if (screenshots) {
    log(`Replacing screenshots (${localizations.length} languages)`);
    await Promise.all(
      localizations.map((localization) =>
        replaceScreenshots(asc, upload, localization.id, screenshots)
      )
    );
  }
  if (options.submit === false) {
    log(`Prepared ${options.version}; not submitting`);
    return { version: versionId, submission: null, state: "NOT_SUBMITTED" };
  }

  // One submission per app collects what goes to review; reuse a draft.
  const [draft] = await list(
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`
  );
  const submission =
    draft ??
    (await create("/v1/reviewSubmissions", {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    }));
  const items = await list(
    `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion`
  );
  if (
    !items.some(
      (item) => item.relationships?.appStoreVersion?.data?.id === versionId
    )
  ) {
    await asc("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submission.id },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: versionId },
          },
        },
      },
    });
  }

  log("Submitting for review");
  const [submitted] = resources(
    await asc("PATCH", `/v1/reviewSubmissions/${submission.id}`, {
      data: {
        type: "reviewSubmissions",
        id: submission.id,
        attributes: { submitted: true },
      },
    })
  );
  return {
    version: versionId,
    submission: submission.id,
    state: String(submitted?.attributes?.state),
  };
};

// Authentication: an ES256 token for the API key, good for 20 minutes.

const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");

const signToken = async (key: { id: string; issuer: string; p8: string }) => {
  const der = Buffer.from(
    key.p8.replaceAll(/-----[^-]+-----/gu, "").replaceAll(/\s+/gu, ""),
    "base64"
  );
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode({ alg: "ES256", kid: key.id, typ: "JWT" })}.${encode({
    iss: key.issuer,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
};

/** Signs in with an API key; `ios-promo-text.ts` uses it too. */
export const connect = async (key: {
  id: string;
  issuer: string;
  p8: string;
}): Promise<Asc> => {
  const token = await signToken(key);
  return async (method, path, body) => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${API}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${text}`);
    }
    return text ? (JSON.parse(text) as AscDocument) : {};
  };
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      build: { type: "string" },
      "whats-new": { type: "string" },
      release: { type: "string", default: "after-approval" },
      screenshots: { type: "string" },
      "no-submit": { type: "boolean", default: false },
    },
  });
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 } = process.env;
  if (!(ASC_KEY_ID && ASC_ISSUER_ID && ASC_KEY_P8)) {
    throw new Error("Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8");
  }
  if (!(values.version && values.build && values["whats-new"])) {
    throw new Error("Pass --version, --build and --whats-new");
  }
  if (values.release !== "after-approval" && values.release !== "manual") {
    throw new Error("--release is after-approval or manual");
  }
  const asc = await connect({
    id: ASC_KEY_ID,
    issuer: ASC_ISSUER_ID,
    p8: ASC_KEY_P8,
  });
  const result = await submitForReview(asc, {
    version: values.version,
    build: values.build,
    whatsNew: values["whats-new"],
    release: values.release,
    screenshots: values.screenshots
      ? exportedScreenshots(values.screenshots)
      : undefined,
    submit: !values["no-submit"],
  });
  log(`${values.version} (${values.build}): ${result.state}`);
}
