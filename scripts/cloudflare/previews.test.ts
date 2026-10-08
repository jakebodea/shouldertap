import { describe, expect, test } from "bun:test";

import {
  closedPreviewNumbers,
  type PullRequest,
  previewAllowed,
  previewNumber,
  previewNumbers,
  type ReadFetch,
  readPullRequest,
  readWorkerNames,
} from "./previews.ts";

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
  test("accepts canonical PR stages and refuses prod, malformed, or unsafe numbers", () => {
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

  test("discovers each Shouldertap preview once, including a partial teardown", () => {
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
    ).toEqual([7, 25]);
  });
});

describe("deploy gate after acquiring the PR lock", () => {
  test("does not redeploy a closed PR after cleanup", () => {
    expect(
      previewAllowed({ ...current, state: "closed" }, repository, current.head)
    ).toBe(false);
  });

  test("skips queued runs superseded by another push", () => {
    expect(previewAllowed(current, repository, "previous-head")).toBe(false);
  });

  test("deploys the current open head, including after reopening", () => {
    expect(previewAllowed(current, repository, current.head)).toBe(true);
  });

  test("does not grant preview credentials to a fork", () => {
    expect(
      previewAllowed(
        { ...current, repository: "fork/shouldertap" },
        repository,
        current.head
      )
    ).toBe(false);
    expect(
      previewAllowed(
        { ...current, repository: undefined },
        repository,
        current.head
      )
    ).toBe(false);
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

  test("keeps all open previews regardless of age and excludes production", async () => {
    const reads: number[] = [];
    const closed = await closedPreviewNumbers(workers, (number) => {
      reads.push(number);
      return Promise.resolve({
        ...current,
        state: [16, 17].includes(number) ? "open" : "closed",
      });
    });
    expect(closed).toEqual([7, 9, 11, 14, 20, 23, 25]);
    expect(reads).toEqual([7, 9, 11, 14, 16, 17, 20, 23, 25]);
  });

  test("fails discovery if a PR cannot be verified instead of assuming it closed", async () => {
    await expect(
      closedPreviewNumbers(workers, () =>
        Promise.reject(new Error("GitHub unavailable"))
      )
    ).rejects.toThrow("GitHub unavailable");
  });
});

describe("provider reads fail closed", () => {
  test("reads GitHub state, exact head, and repository", async () => {
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
    ).resolves.toEqual({ ...current, state: "closed" });
    expect(reads).toEqual([
      "https://github.test/repos/jakebodea/shouldertap/pulls/25",
    ]);
  });

  test.each([403, 404, 500])(
    "refuses GitHub HTTP %s instead of assuming the PR closed",
    async (status) => {
      await expect(
        readPullRequest({ ...context, fetchImpl: response({}, status) }, 25)
      ).rejects.toThrow(`failed: ${status}`);
    }
  );

  test.each([
    null,
    {},
    { state: "unknown", head: {} },
    { state: "closed", head: { sha: 25, repo: null } },
  ])("rejects malformed GitHub state: %j", async (body) => {
    await expect(
      readPullRequest({ ...context, fetchImpl: response(body) }, 25)
    ).rejects.toThrow();
  });

  test.each([
    { success: false, result: [] },
    { success: true, result: [{}] },
    { success: true, result: null },
  ])("rejects invalid Cloudflare results: %j", async (body) => {
    await expect(
      readWorkerNames("account", "token", response(body))
    ).rejects.toThrow();
  });

  test("refuses Cloudflare HTTP errors", async () => {
    await expect(
      readWorkerNames("account", "token", response({}, 403))
    ).rejects.toThrow("failed: 403");
  });

  test("reads live Worker names without selecting unrelated resources", async () => {
    const names = ["shouldertap-pr-25-server", "unrelated-prod"];
    await expect(
      readWorkerNames(
        "account",
        "token",
        response({ success: true, result: names.map((id) => ({ id })) })
      )
    ).resolves.toEqual(names);
  });
});
