/**
 * Which Infisical project and environment a stage's app secrets come from.
 * On the free plan the project is the only access boundary, so prod and dev
 * credentials live in separate projects, each readable by its own identity.
 */
import * as Infisical from "alchemy/Infisical";

import { isProduction } from "./domains.ts";
import { previewNumber } from "./scripts/cloudflare/previews.ts";

/** Deployed values; read by `ci-prod` (main only) and the operator. */
export const prodProject = "2ea55940-47f3-4632-ad30-1b8ebdf9daeb";
/** Development credentials; the only project agents (`agent-dev`) can read. */
export const devProject = "fcaaebbd-83e7-4945-911f-cedba3ff25a3";

/**
 * `prod` reads shouldertap-prod. PR previews read nothing: their CI job has
 * no Infisical identity, and they must never see prod values. Every other
 * stage (local dev) reads shouldertap-dev.
 */
export const secretsSource = (stage: string) => {
  if (isProduction(stage)) {
    return { project: prodProject, environment: "prod" };
  }
  if (previewNumber(stage) !== undefined) {
    return;
  }
  return { project: devProject, environment: "dev" };
};

/** The Stack's `secrets` option. The shell still overrides any value. */
export const stageSecrets = ({ stage }: { stage: string }) => {
  const source = secretsSource(stage);
  return source ? [Infisical.Secrets(source)] : [];
};
