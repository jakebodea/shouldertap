/**
 * Put the Mac release keys in Infisical `shouldertap-prod` › prod, where the
 * Release workflow reads them. Every Infisical identity is read-only, so you
 * paste each value into the dashboard yourself; this does the rest:
 *
 *   bun run keys:mac
 *
 * It exports the Developer ID identity and the Sparkle update key from the
 * login keychain (macOS asks to allow each), opens Infisical, copies one
 * value at a time to the clipboard, checks each paste through the read-only
 * `admin` profile, then clears the clipboard and deletes the exports.
 * Values are never printed. Run it again to rotate either key.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { infisical } from "../stacks/secrets.ts";
import { infisicalSession } from "./with-release-secrets.ts";

const identity = "Developer ID Application: Jake Bodea (6C46GY4Z38)";
const root = path.join(import.meta.dirname, "..");
const sparkleBin = path.join(
  root,
  "apps/macos/.build/artifacts/sparkle/Sparkle/bin"
);
const developerDir = {
  ...process.env,
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
};

/** Exports into an owner-only folder; an existing folder (argv) is reused. */
const exportKeys = (directory: string) => {
  if (existsSync(path.join(directory, "id.p12"))) {
    return;
  }
  const pass = execFileSync("openssl", ["rand", "-hex", "24"])
    .toString()
    .trim();
  writeFileSync(path.join(directory, "pass"), pass, { mode: 0o600 });
  console.log(
    "Exporting the Developer ID identity (click Allow if macOS asks)…"
  );
  execFileSync(
    "swift",
    [
      path.join(root, "apps/macos/scripts/export-identity.swift"),
      identity,
      path.join(directory, "id.p12"),
      pass,
    ],
    { stdio: "inherit", env: developerDir }
  );
  if (!existsSync(sparkleBin)) {
    execFileSync(
      "swift",
      ["build", "--package-path", path.join(root, "apps/macos")],
      { stdio: "inherit", env: developerDir }
    );
  }
  console.log("Exporting the Sparkle update key (click Allow if macOS asks)…");
  execFileSync(
    path.join(sparkleBin, "generate_keys"),
    [
      "--account",
      "app.shouldertap.mac",
      "-x",
      path.join(directory, "sparkle.key"),
    ],
    {
      stdio: "inherit",
    }
  );
};

const readBack = async (
  session: Awaited<ReturnType<typeof infisicalSession>>
) => {
  const url = new URL("/api/v4/secrets", session.apiBaseUrl);
  url.search = new URLSearchParams({
    projectId: infisical.prod,
    environment: "prod",
    secretPath: "/",
    viewSecretValue: "true",
  }).toString();
  const response = await fetch(url, {
    headers: { authorization: session.authorization },
  });
  const body = (await response.json()) as {
    secrets?: { secretKey: string; secretValue: string }[];
  };
  return new Map(
    (body.secrets ?? []).map((secret) => [secret.secretKey, secret.secretValue])
  );
};

const given = process.argv.at(2);
const directory =
  given ?? mkdtempSync(path.join(tmpdir(), "shouldertap-keys-"));
const copy = (value: string) => execFileSync("pbcopy", { input: value });
try {
  exportKeys(directory);
  const read = (name: string) => readFileSync(path.join(directory, name));
  const secrets: [string, string][] = [
    ["MAC_DEVELOPER_ID_P12", read("id.p12").toString("base64")],
    ["MAC_DEVELOPER_ID_P12_PASSWORD", read("pass").toString("utf-8").trim()],
    ["SPARKLE_ED_PRIVATE_KEY", read("sparkle.key").toString("utf-8").trim()],
  ];
  const session = await infisicalSession(
    process.env.ALCHEMY_PROFILE || "admin"
  );
  execFileSync("open", ["https://app.infisical.com"]);
  console.log("\nIn Infisical, open shouldertap-prod › Production.\n");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // Interactive: each secret waits for you to paste and save it.
  const pasteOne = async (
    label: string,
    name: string,
    value: string
  ): Promise<void> => {
    await prompt.question(
      `${label}  Add secret  ${name}  and paste the value (it's on your clipboard). Press Enter when saved. `
    );
    const values = await readBack(session);
    const stored = values.get(name);
    if (stored === value) {
      console.log(`    ✓ ${name} saved\n`);
      return;
    }
    copy(value);
    console.log(
      stored === undefined
        ? `    ${name} isn't there yet. Check the name and the Production environment, then press Enter.`
        : `    ${name} doesn't match. The value is on your clipboard again; replace it and press Enter.`
    );
    return pasteOne(label, name, value);
  };
  for (const [index, [name, value]] of secrets.entries()) {
    copy(value);
    // oxlint-disable-next-line no-await-in-loop -- one at a time, by design: you paste each in turn
    await pasteOne(`${index + 1}/${secrets.length}`, name, value);
  }
  prompt.close();
  console.log(
    "All set: the Release workflow can sign and publish the Mac app."
  );
} finally {
  copy("");
  if (!given) {
    rmSync(directory, { recursive: true, force: true });
  }
}
