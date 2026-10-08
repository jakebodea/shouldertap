import { appendFile } from "node:fs/promises";

import {
  closedPreviewNumbers,
  previewNumber,
  readPullRequest,
  readWorkerNames,
  requiredEnv,
} from "./previews.ts";

const fromCloseEvent = process.env.PULL_REQUEST;
let numbers: number[];
if (fromCloseEvent) {
  const number = previewNumber(`pr-${fromCloseEvent}`);
  if (number === undefined) {
    throw new Error("PULL_REQUEST must be a positive integer");
  }
  numbers = [number];
} else {
  const workerNames = await readWorkerNames(
    requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    requiredEnv("CLOUDFLARE_API_TOKEN")
  );
  const context = {
    repository: requiredEnv("GITHUB_REPOSITORY"),
    token: requiredEnv("GITHUB_TOKEN"),
    apiUrl: process.env.GITHUB_API_URL,
  };
  numbers = await closedPreviewNumbers(workerNames, (number) =>
    readPullRequest(context, number)
  );
}
if (numbers.length > 256) {
  throw new Error("Too many previews for a GitHub Actions matrix");
}
const json = JSON.stringify(numbers);
process.stdout.write(`${json}\n`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `pull-requests=${json}\n`);
}
