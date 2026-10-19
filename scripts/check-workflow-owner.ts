import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The repo moved from the jakebodea account to the jbolabs org. A leftover
// owner in a workflow (e.g. Infisical's oidc-audience) breaks prod deploys.
const OLD_OWNER = "jakebodea";
const FIX =
  "repo moved to jbolabs; use https://github.com/jbolabs / jbolabs/shouldertap";

export const findStaleOwnerReferences = (
  files: readonly { path: string; text: string }[]
): string[] =>
  files.flatMap(({ path: file, text }) =>
    text
      .split("\n")
      .flatMap((line, i) =>
        line.includes(OLD_OWNER) ? [`${file}:${i + 1}: ${FIX}`] : []
      )
  );

export const readWorkflows = (dir = ".github/workflows") =>
  readdirSync(dir).map((name) => ({
    path: path.join(dir, name),
    text: readFileSync(path.join(dir, name), "utf-8"),
  }));
