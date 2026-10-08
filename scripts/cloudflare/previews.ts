const physicalNameHash = /^[a-z0-9]+$/u;

export const previewNumber = (stage: string): number | undefined => {
  const number = Number(stage.slice(3));
  return Number.isSafeInteger(number) && number > 0 && stage === `pr-${number}`
    ? number
    : undefined;
};

const workerPreviewNumber = (name: string): number | undefined => {
  const [stack, first, second, third, fourth, ...rest] = name.split("-");
  if (stack !== "shouldertap" || rest.length > 0) {
    return undefined;
  }
  // Alchemy's generated physical names: shouldertap-server-pr-25-<hash>.
  if (
    (first === "server" || first === "web") &&
    second === "pr" &&
    typeof fourth === "string" &&
    physicalNameHash.test(fourth)
  ) {
    return previewNumber(`pr-${third}`);
  }
  // Also recognize previews with explicit, unhashed legacy names.
  if (
    first === "pr" &&
    (third === "server" || third === "web") &&
    fourth === undefined
  ) {
    return previewNumber(`pr-${second}`);
  }
  return undefined;
};

export const previewNumbers = (workerNames: readonly string[]): number[] =>
  [
    ...new Set(
      workerNames.flatMap((name) => {
        const number = workerPreviewNumber(name);
        return number === undefined ? [] : [number];
      })
    ),
  ].toSorted((a, b) => a - b);

export interface PullRequest {
  head: string;
  repository: string | undefined;
  state: "open" | "closed";
}

interface GitHubContext {
  apiUrl?: string;
  fetchImpl?: ReadFetch;
  repository: string;
  token: string;
}

export type ReadFetch = (url: string, init?: RequestInit) => Promise<Response>;

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an API object");
  }
  return value as Record<string, unknown>;
};

export const readPullRequest = async (
  {
    repository,
    token,
    apiUrl = "https://api.github.com",
    fetchImpl = fetch,
  }: GitHubContext,
  number: number
): Promise<PullRequest> => {
  if (previewNumber(`pr-${number}`) === undefined) {
    throw new Error("Invalid pull request number");
  }
  const response = await fetchImpl(
    `${apiUrl}/repos/${repository}/pulls/${number}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    }
  );
  if (!response.ok) {
    // A 404 or authorization failure is not proof that a PR is closed.
    throw new Error(`Reading PR #${number} failed: ${response.status}`);
  }
  const body = object(await response.json());
  const head = object(body.head);
  const headRepository =
    head.repo === null ? undefined : object(head.repo).full_name;
  if (
    (body.state !== "open" && body.state !== "closed") ||
    typeof head.sha !== "string" ||
    (headRepository !== undefined && typeof headRepository !== "string")
  ) {
    throw new Error(`Invalid response for PR #${number}`);
  }
  return { state: body.state, head: head.sha, repository: headRepository };
};

export const previewAllowed = (
  pullRequest: PullRequest,
  repository: string,
  expectedHead: string
): boolean =>
  pullRequest.state === "open" &&
  pullRequest.repository === repository &&
  pullRequest.head === expectedHead;

export const closedPreviewNumbers = async (
  workerNames: readonly string[],
  read: (number: number) => Promise<PullRequest>
): Promise<number[]> => {
  const candidates = previewNumbers(workerNames);
  const states = await Promise.all(candidates.map(read));
  return candidates.filter((_, index) => states[index]?.state === "closed");
};

export const readWorkerNames = async (
  accountId: string,
  token: string,
  fetchImpl: ReadFetch = fetch
): Promise<string[]> => {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw new Error(`Listing Workers failed: ${response.status}`);
  }
  const body = object(await response.json());
  if (body.success !== true || !Array.isArray(body.result)) {
    throw new Error("Listing Workers returned an invalid result");
  }
  return body.result.map((worker: unknown) => {
    const { id } = object(worker);
    if (typeof id !== "string") {
      throw new TypeError("Worker is missing its name");
    }
    return id;
  });
};

export const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};
