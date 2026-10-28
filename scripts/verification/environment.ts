/* eslint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- Adapt the Node TCP listener boundary to an awaitable port allocation. */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { verificationStageCreatedAt } from "../cloudflare/previews.ts";

// The timestamp is part of the resource name so an interrupted run can be
// reclaimed without trusting a file left on the agent's machine.
export const verificationStage = (now = Date.now()) =>
  `verify-${now.toString(36)}-${randomBytes(6).toString("hex")}`;

export const stageCreatedAt = (stage: string): number => {
  const timestamp = verificationStageCreatedAt(stage);
  if (timestamp === undefined) {
    throw new Error(`Refusing non-verification stage: ${stage}`);
  }
  return timestamp;
};
export const assertVerificationStage = (stage: string) => {
  stageCreatedAt(stage);
  return stage;
};

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No port allocated"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

export const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export const assertDeployment = (
  version: unknown,
  expected: string,
  expectedDigest?: string
) => {
  if (
    typeof version !== "object" ||
    version === null ||
    !("sourceRevision" in version) ||
    version.sourceRevision !== expected ||
    (expectedDigest !== undefined &&
      (!("sourceDigest" in version) || version.sourceDigest !== expectedDigest))
  ) {
    throw new Error("Deployment revision does not match the tested source");
  }
};
