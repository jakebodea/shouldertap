import { describe, expect, it } from "vitest";

import { submitForReview } from "./submit-ios";
import type { Asc, AscDocument } from "./submit-ios";

interface Version {
  id: string;
  attributes: Record<string, string>;
  build: string | null;
  whatsNew: Record<string, string>;
}

interface Submission {
  id: string;
  versions: string[];
  submitted: boolean;
}

/** What the script sends: JSON:API bodies with a `data` resource. */
interface Body {
  data: {
    id?: string;
    attributes: Record<string, string | boolean>;
    relationships: Record<string, { data: { id: string } }>;
  };
}

type Handler = (
  url: URL,
  body: Body
) => AscDocument | Record<string, never> | undefined;

const q = (url: URL, name: string) => url.searchParams.get(name);

/**
 * A small App Store Connect: one app with the live 0.2.0 and an uploaded
 * build, answering the requests the script makes as Apple documents them.
 */
const fakeAsc = (buildState = "VALID") => {
  const versions: Version[] = [
    {
      id: "v020",
      attributes: {
        versionString: "0.2.0",
        appStoreState: "READY_FOR_SALE",
        releaseType: "AFTER_APPROVAL",
      },
      build: "b10",
      whatsNew: { "en-US": "Shouldertap starts on iPhone." },
    },
  ];
  const submissions: Submission[] = [];
  const builds = [
    { id: "b10", version: "10", pre: "0.2.0", processingState: "VALID" },
    { id: "b11", version: "11", pre: "0.2.1", processingState: buildState },
  ];
  const versionIn = (url: URL) =>
    versions.find((v) => url.pathname.split("/").includes(v.id));
  const submissionIn = (url: URL) =>
    submissions.find((s) => url.pathname.split("/").includes(s.id));

  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/v1\/apps$/u,
      (url) => ({
        data:
          q(url, "filter[bundleId]") === "app.shouldertap.iphone"
            ? [{ id: "app1" }]
            : [],
      }),
    ],
    [
      "GET",
      /^\/v1\/builds$/u,
      (url) => ({
        data: builds
          .filter(
            (b) =>
              b.version === q(url, "filter[version]") &&
              b.pre === q(url, "filter[preReleaseVersion.version]")
          )
          .map((b) => ({
            id: b.id,
            attributes: { processingState: b.processingState },
          })),
      }),
    ],
    [
      "GET",
      /^\/v1\/apps\/app1\/appStoreVersions$/u,
      (url) => ({
        data: versions.filter(
          (v) => v.attributes.versionString === q(url, "filter[versionString]")
        ),
      }),
    ],
    [
      "POST",
      /^\/v1\/appStoreVersions$/u,
      (_url, body) => {
        const version: Version = {
          id: `v${versions.length}`,
          attributes: {
            ...(body.data.attributes as Record<string, string>),
            appStoreState: "PREPARE_FOR_SUBMISSION",
          },
          build: null,
          whatsNew: { "en-US": "" },
        };
        versions.push(version);
        return { data: { id: version.id } };
      },
    ],
    [
      "PATCH",
      /\/relationships\/build$/u,
      (url, body) => {
        const version = versionIn(url);
        if (version) {
          version.build = body.data.id ?? null;
        }
        return {};
      },
    ],
    [
      "PATCH",
      /^\/v1\/appStoreVersions\/[^/]+$/u,
      (url, body) => {
        const version = versionIn(url);
        if (version) {
          Object.assign(version.attributes, body.data.attributes);
        }
        return {};
      },
    ],
    [
      "GET",
      /\/appStoreVersionLocalizations$/u,
      (url) => {
        const version = versionIn(url);
        return {
          data: Object.keys(version?.whatsNew ?? {}).map((locale) => ({
            id: `${version?.id}~${locale}`,
            attributes: { locale },
          })),
        };
      },
    ],
    [
      "PATCH",
      /^\/v1\/appStoreVersionLocalizations\//u,
      (url, body) => {
        const [id, locale] = (url.pathname.split("/").at(-1) ?? "").split("~");
        const version = versions.find((v) => v.id === id);
        if (version && locale) {
          version.whatsNew[locale] = String(body.data.attributes.whatsNew);
        }
        return {};
      },
    ],
    [
      "GET",
      /^\/v1\/reviewSubmissions$/u,
      () => ({
        data: submissions
          .filter((s) => !s.submitted)
          .map((s) => ({ id: s.id })),
      }),
    ],
    [
      "POST",
      /^\/v1\/reviewSubmissions$/u,
      () => {
        const submission = {
          id: `s${submissions.length}`,
          versions: [],
          submitted: false,
        };
        submissions.push(submission);
        return { data: { id: submission.id } };
      },
    ],
    [
      "GET",
      /\/items$/u,
      (url) => ({
        data: (submissionIn(url)?.versions ?? []).map((id) => ({
          id: `item-${id}`,
          relationships: { appStoreVersion: { data: { id } } },
        })),
      }),
    ],
    [
      "POST",
      /^\/v1\/reviewSubmissionItems$/u,
      (_url, body) => {
        const { reviewSubmission, appStoreVersion } = body.data.relationships;
        submissions
          .find((s) => s.id === reviewSubmission?.data.id)
          ?.versions.push(appStoreVersion?.data.id ?? "");
        return {};
      },
    ],
    [
      "PATCH",
      /^\/v1\/reviewSubmissions\//u,
      (url, body) => {
        const submission = submissionIn(url);
        if (!submission) {
          return;
        }
        submission.submitted = body.data.attributes.submitted === true;
        for (const version of versions) {
          if (submission.versions.includes(version.id)) {
            version.attributes.appStoreState = "WAITING_FOR_REVIEW";
          }
        }
        return {
          data: {
            id: submission.id,
            attributes: { state: "WAITING_FOR_REVIEW" },
          },
        };
      },
    ],
  ];

  const asc: Asc = (method, path, body) => {
    const url = new URL(path, "https://asc.test");
    const route = routes.find(
      ([m, pattern]) => m === method && pattern.test(url.pathname)
    );
    const answer = route?.[2](url, body as Body);
    return answer
      ? Promise.resolve(answer)
      : Promise.reject(new Error(`Unexpected ${method} ${url.pathname}`));
  };
  return { asc, versions, submissions };
};

const options = {
  version: "0.2.1",
  build: "11",
  whatsNew: "Invite links now open right in the app.",
  release: "after-approval" as const,
};

describe("submitting an iPhone build for App Review", () => {
  it("makes the version, attaches the build, sets What's New and submits", async () => {
    const { asc, versions, submissions } = fakeAsc();
    const result = await submitForReview(asc, options);
    expect(result.state).toBe("WAITING_FOR_REVIEW");
    const version = versions.find(
      (v) => v.attributes.versionString === "0.2.1"
    );
    expect(version?.build).toBe("b11");
    expect(version?.whatsNew).toStrictEqual({
      "en-US": "Invite links now open right in the app.",
    });
    expect(version?.attributes.releaseType).toBe("AFTER_APPROVAL");
    expect(submissions).toStrictEqual([
      { id: "s0", versions: [version?.id], submitted: true },
    ]);
  });

  it("won't submit a version that's already waiting for review", async () => {
    const { asc } = fakeAsc();
    await submitForReview(asc, options);
    await expect(submitForReview(asc, options)).rejects.toThrow(
      "Version 0.2.1 is already WAITING_FOR_REVIEW"
    );
  });

  it("waits for Apple to finish processing the build", async () => {
    const { asc, versions } = fakeAsc("PROCESSING");
    await expect(submitForReview(asc, options)).rejects.toThrow(
      "Build 0.2.1 (11) is PROCESSING, not VALID yet"
    );
    expect(versions.map((v) => v.attributes.versionString)).toStrictEqual([
      "0.2.0",
    ]);
  });
});
