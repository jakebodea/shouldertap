/**
 * Where each stage's app secrets come from, and the only place the Infisical
 * project ids live. On the free plan the project is the only access
 * boundary, so prod and dev credentials sit in separate projects, each
 * readable by its own identity.
 */
import * as Infisical from "alchemy/Infisical";

import { isProduction } from "../domains.ts";
import { previewNumber } from "../scripts/cloudflare/previews.ts";

export const infisical = {
  /** shouldertap-dev: development credentials; `agent-dev` reads it. */
  dev: "fcaaebbd-83e7-4945-911f-cedba3ff25a3",
  /** shouldertap-prod: deployed values; `ci-prod` (production env) and `operator`. */
  prod: "2ea55940-47f3-4632-ad30-1b8ebdf9daeb",
} as const;

/**
 * `prod` reads shouldertap-prod. PR previews, and any other stage deployed
 * from GitHub Actions, read nothing: only the `production` environment's job
 * has an Infisical identity, and previews must never see prod values. Every
 * other stage (local dev) reads shouldertap-dev.
 */
export const secretsSource = (stage: string, inGitHubActions: boolean) => {
  if (isProduction(stage)) {
    return { project: infisical.prod, environment: "prod" };
  }
  if (previewNumber(stage) !== undefined || inGitHubActions) {
    return;
  }
  return { project: infisical.dev, environment: "dev" };
};

/** The Stack's `secrets` option. The shell still overrides any value. */
export const stageSecrets = ({ stage }: { stage: string }) => {
  // Not a secret: GitHub sets it on every Actions runner.
  const source = secretsSource(stage, process.env.GITHUB_ACTIONS === "true");
  return source ? [Infisical.Secrets(source)] : [];
};
