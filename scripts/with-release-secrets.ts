/**
 * Run a release script with the App Store Connect key from Infisical
 * `shouldertap-prod`, through the same Alchemy profile that deploys prod:
 *
 *   bun scripts/with-release-secrets.ts scripts/release-mac.sh
 *   bun scripts/with-release-secrets.ts scripts/release-ios.sh
 *
 * The profile is `admin` (the operator identity; the owner's Mac only)
 * unless ALCHEMY_PROFILE says otherwise. The key is written to an
 * owner-only temp file for the run, then deleted; values are never printed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { mintAccessToken } from "alchemy/Infisical";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";

import { infisical } from "../stacks/secrets.ts";

/** What each release script reads, by the names it reads them. */
export const releaseEnv = (
  secrets: Record<string, string>,
  keyPath: string
): Record<string, string> => {
  const keyId = secrets.ASC_KEY_ID;
  const issuer = secrets.ASC_ISSUER_ID;
  if (!(keyId && issuer && secrets.ASC_KEY_P8)) {
    throw new Error(
      "shouldertap-prod is missing ASC_KEY_ID, ASC_ISSUER_ID or ASC_KEY_P8"
    );
  }
  return {
    // release-mac.sh: notarize with the API key.
    NOTARY_KEY: keyPath,
    NOTARY_KEY_ID: keyId,
    NOTARY_ISSUER: issuer,
    // release-ios.sh: sign and upload with the same key.
    ASC_KEY_PATH: keyPath,
    ASC_KEY_ID: keyId,
    ASC_ISSUER_ID: issuer,
  };
};

/** An Infisical token minted from the Alchemy profile's machine identity. */
export const infisicalSession = async (profile: string) => {
  const file = path.join(
    homedir(),
    ".alchemy",
    "profiles",
    profile,
    "infisical.json"
  );
  const { values } = JSON.parse(readFileSync(file, "utf-8")) as {
    values: { clientId: string; clientSecret: string; apiBaseUrl?: string };
  };
  const { token, apiBaseUrl } = await Effect.runPromise(
    mintAccessToken(values).pipe(Effect.provide(FetchHttpClient.layer))
  );
  return { apiBaseUrl, authorization: `Bearer ${Redacted.value(token)}` };
};

const loadSecrets = async (profile: string) => {
  const { apiBaseUrl, authorization } = await infisicalSession(profile);
  const url = new URL("/api/v4/secrets", apiBaseUrl);
  url.search = new URLSearchParams({
    projectId: infisical.prod,
    environment: "prod",
    secretPath: "/",
    viewSecretValue: "true",
    expandSecretReferences: "true",
  }).toString();
  const response = await fetch(url, { headers: { authorization } });
  if (!response.ok) {
    throw new Error(
      `Infisical could not read shouldertap-prod with the '${profile}' profile (${response.status})`
    );
  }
  const body = (await response.json()) as {
    secrets: { secretKey: string; secretValue: string }[];
  };
  return Object.fromEntries(
    body.secrets.map((secret) => [secret.secretKey, secret.secretValue])
  );
};

if (import.meta.main) {
  const command = process.argv.slice(2);
  if (command.length === 0) {
    console.error(
      "Usage: bun scripts/with-release-secrets.ts <command> [args…]"
    );
    process.exit(2);
  }
  const profile = process.env.ALCHEMY_PROFILE || "admin";
  const secrets = await loadSecrets(profile);
  const directory = mkdtempSync(path.join(tmpdir(), "shouldertap-release-"));
  const keyPath = path.join(directory, `AuthKey_${secrets.ASC_KEY_ID}.p8`);
  let status = 1;
  try {
    const env = releaseEnv(secrets, keyPath);
    writeFileSync(keyPath, secrets.ASC_KEY_P8 ?? "", { mode: 0o600 });
    console.log(
      `Loaded the App Store Connect key from shouldertap-prod (${profile} profile).`
    );
    const result = spawnSync(command[0] ?? "", command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    status = result.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(status);
}
