/** Fail when the Mac and Windows apps don't share one version: desktop releases move together. */
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (relative: string) =>
  readFileSync(path.join(import.meta.dirname, "..", relative), "utf-8");

export const parsePlistVersion = (source: string): string | undefined =>
  source.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>(?<version>[^<]+)<\/string>/u
  )?.groups?.version;

/** The `[workspace.package]` version in apps/windows/Cargo.toml. */
export const parseCargoVersion = (source: string): string | undefined =>
  source.match(
    /\[workspace\.package\][^[]*?^version\s*=\s*"(?<version>[^"]+)"/mu
  )?.groups?.version;

export const desktopVersionError = (
  mac: string | undefined,
  windows: string | undefined
): string | undefined => {
  if (!(mac && windows)) {
    return "Could not read the Mac or Windows version";
  }
  return mac === windows
    ? undefined
    : `Mac is ${mac} but Windows is ${windows}: bump apps/macos/Resources/Info.plist and apps/windows/Cargo.toml together`;
};

if (import.meta.main) {
  const error = desktopVersionError(
    parsePlistVersion(read("apps/macos/Resources/Info.plist")),
    parseCargoVersion(read("apps/windows/Cargo.toml"))
  );
  if (error) {
    console.error(`Desktop version check failed: ${error}`);
    process.exit(1);
  }
  console.log("OK: Mac and Windows share one version.");
}
