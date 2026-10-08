import { describe, expect, it } from "vitest";

import {
  closedPreviewNumbers,
  previewAllowed,
  previewNumber,
  previewNumbers,
  readPullRequest,
  readWorkerNames,
} from "./previews.ts";
import type { PullRequest, ReadFetch } from "./previews.ts";

const repository = "jakebodea/shouldertap";
const current: PullRequest = {
  state: "open",
  head: "current-head",
  repository,
};
const context = {
  repository,
  token: "test-token",
  apiUrl: "https://github.test",
};
const response =
  (body: unknown, status = 200): ReadFetch =>
  () =>
    Promise.resolve(Response.json(body, { status }));

describe("preview boundaries", () => {
  it("accepts canonical PR stages and refuses prod, malformed, or unsafe numbers", () => {
    expect(previewNumber("pr-25")).toBe(25);
    for (const stage of [
      "prod",
      "staging",
      "pr-0",
      "pr-01",
      "pr--1",
      "pr-1/web",
      "pr-1\n",
      "pr-9007199254740992",
    ]) {
      expect(previewNumber(stage)).toBeUndefined();
    }
  });

  it("discovers each Shouldertap preview once, including a partial teardown", () => {
    expect(
      previewNumbers([
        "shouldertap-prod-server",
        "shouldertap-server-pr-25-5tocqp5ogegfgq5j",
        "shouldertap-web-pr-25-tpqfzjelkqlnauhq",
        "shouldertap-pr-7-web",
        "shouldertap-server-pr-7-5tocqp5ogegfgq5j",
        "pcobooster-pr-9-web",
        "shouldertap-pr-01-web",
        "shouldertap-pr-9-server-old",
        "shouldertap-server-prod-5tocqp5ogegfgq5j",
        "shouldertap-server-pr-9-",
        "shouldertap-server-pr-9-hash-extra",
        "shouldertap-releases",
      ])
    ).toStrictEqual([7, 25]);
  });
});

describe("deploy gate after acquiring the PR lock", () => {
  it("does not redeploy a closed PR after cleanup", () => {
    expect(
      previewAllowed({ ...current, state: "closed" }, repository, current.head)
    ).toBeFalsy();
  });

  it("skips queued runs superseded by another push", () => {
    expect(previewAllowed(current, repository, "previous-head")).toBeFalsy();
  });

  it("deploys the current open head, including after reopening", () => {
    expect(previewAllowed(current, repository, current.head)).toBeTruthy();
  });

  it("does not grant preview credentials to a fork", () => {
    expect(
      previewAllowed(
        { ...current, repository: "fork/shouldertap" },
        repository,
        current.head
      )
    ).toBeFalsy();
    expect(
      previewAllowed(
        { ...current, repository: undefined },
        repository,
        current.head
      )
    ).toBeFalsy();
  });
});

describe("daily discovery", () => {
  const workers = [
    "shouldertap-prod-server",
    ...[7, 9, 11, 14, 16, 17, 20, 23, 25].flatMap((number) => [
      `shouldertap-server-pr-${number}-5tocqp5ogegfgq5j`,
      `shouldertap-web-pr-${number}-tpqfzjelkqlnauhq`,
    ]),
  ];

  it("keeps all open previews regardless of age and excludes production", async () => {
    const reads: number[] = [];
    const closed = await closedPreviewNumbers(workers, (number) => {
      reads.push(number);
      return Promise.resolve({
        ...current,
        state: [16, 17].includes(number) ? "open" : "closed",
      });
    });
    expect(closed).toStrictEqual([7, 9, 11, 14, 20, 23, 25]);
    expect(reads).toStrictEqual([7, 9, 11, 14, 16, 17, 20, 23, 25]);
  });

  it("fails discovery if a PR cannot be verified instead of assuming it closed", async () => {
    await expect(
      closedPreviewNumbers(workers, () =>
        Promise.reject(new Error("GitHub unavailable"))
      )
    ).rejects.toThrow("GitHub unavailable");
  });
});

describe("provider reads fail closed", () => {
  it("reads GitHub state, exact head, and repository", async () => {
    const reads: string[] = [];
    const fetchImpl: ReadFetch = (input) => {
      reads.push(String(input));
      return Promise.resolve(
        Response.json({
          state: "closed",
          head: { sha: current.head, repo: { full_name: repository } },
        })
      );
    };
    await expect(
      readPullRequest({ ...context, fetchImpl }, 25)
    ).resolves.toStrictEqual({ ...current, state: "closed" });
    expect(reads).toStrictEqual([
      "https://github.test/repos/jakebodea/shouldertap/pulls/25",
    ]);
  });

  it.each([403, 404, 500])(
    "refuses GitHub HTTP %s instead of assuming the PR closed",
    async (status) => {
      await expect(
        readPullRequest({ ...context, fetchImpl: response({}, status) }, 25)
      ).rejects.toThrow(`failed: ${status}`);
    }
  );

  it.each([
    [null, "Expected an API object"],
    [{}, "Expected an API object"],
    [{ state: "unknown", head: {} }, "Expected an API object"],
    [
      { state: "closed", head: { sha: 25, repo: null } },
      "Invalid response for PR #25",
    ],
  ])("rejects malformed GitHub state: %j", async (body, message) => {
    await expect(
      readPullRequest({ ...context, fetchImpl: response(body) }, 25)
    ).rejects.toThrow(message);
  });

  it.each([
    [
      { success: false, result: [] },
      "Listing Workers returned an invalid result",
    ],
    [{ success: true, result: [{}] }, "Worker is missing its name"],
    [
      { success: true, result: null },
      "Listing Workers returned an invalid result",
    ],
  ])("rejects invalid Cloudflare results: %j", async (body, message) => {
    await expect(
      readWorkerNames("account", "token", response(body))
    ).rejects.toThrow(message);
  });

  it("refuses Cloudflare HTTP errors", async () => {
    await expect(
      readWorkerNames("account", "token", response({}, 403))
    ).rejects.toThrow("failed: 403");
  });

  it("reads live Worker names without selecting unrelated resources", async () => {
    const names = ["shouldertap-pr-25-server", "unrelated-prod"];
    await expect(
      readWorkerNames(
        "account",
        "token",
        response({ success: true, result: names.map((id) => ({ id })) })
      )
    ).resolves.toStrictEqual(names);
  });
});
