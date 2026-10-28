import path from "node:path";

import {
  cleanupExpiredVerificationStages,
  expiredVerificationStages,
  readWorkerNames,
  requiredEnv,
} from "../cloudflare/previews.ts";

// This command deliberately does not accept the production credential names.
const accountId = requiredEnv("CLOUDFLARE_TEST_ACCOUNT_ID");
const token = requiredEnv("CLOUDFLARE_TEST_API_TOKEN");
const args: string[] = process.argv.slice(2);
if (args.some((argument) => argument !== "--dry-run")) {
  throw new Error(
    "Only --dry-run is accepted; stages are discovered automatically"
  );
}
const workers = await readWorkerNames(accountId, token);
if (args.includes("--dry-run")) {
  process.stdout.write(
    `${JSON.stringify(expiredVerificationStages(workers, Date.now()))}\n`
  );
} else {
  const destroyed = await cleanupExpiredVerificationStages(
    workers,
    Date.now,
    async (stage) => {
      const child = Bun.spawn(
        [
          "bun",
          "alchemy",
          "destroy",
          "alchemy.cleanup.ts",
          "--stage",
          stage,
          "--no-input",
          "--yes",
        ],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_API_TOKEN: token,
          },
          stdout: "inherit",
          stderr: "inherit",
          timeout: 240_000,
        }
      );
      if ((await child.exited) !== 0) {
        throw new Error(`Verification cleanup failed for ${stage}`);
      }
    }
  );
  process.stdout.write(`${JSON.stringify(destroyed)}\n`);
}
