import {
  previewAllowed,
  previewNumber,
  readPullRequest,
  requiredEnv,
} from "./previews.ts";

const [, , mode] = process.argv;
if (mode !== "deploy" && mode !== "cleanup") {
  throw new Error(
    "Usage: bun scripts/cloudflare/preview-gate.ts deploy|cleanup"
  );
}
const number = previewNumber(`pr-${requiredEnv("PULL_REQUEST")}`);
if (number === undefined) {
  throw new Error("PULL_REQUEST must be a positive integer");
}
const repository = requiredEnv("GITHUB_REPOSITORY");
const pullRequest = await readPullRequest(
  {
    repository,
    token: requiredEnv("GITHUB_TOKEN"),
    apiUrl: process.env.GITHUB_API_URL,
  },
  number
);
const allowed =
  mode === "cleanup"
    ? pullRequest.state === "closed"
    : previewAllowed(pullRequest, repository, requiredEnv("EXPECTED_HEAD"));

// Only the boolean goes to stdout; workflows fail on lookup errors.
process.stdout.write(`${allowed}\n`);
