/**
 * Which Deploy gates a pull request's changed files need. Only PRs are
 * scoped: pushes to main run every gate, because prod deploys and Release
 * (which ships the native apps) trust that run. Anything unrecognised runs
 * everything; verification-policy.ts never lets a push skip a gate.
 */
export interface Affected {
  native: boolean;
  web: boolean;
}

const everything: Affected = { native: true, web: true };

// Inputs of native.yml's jobs: the apps and the DMG packaging script.
const nativePrefixes = ["apps/macos/", "apps/ios/", "apps/windows/"];
const nativeFiles = new Set(["scripts/release-mac.sh"]);

const isDocs = (file: string) =>
  file.startsWith("docs/") || file.endsWith(".md");
const isNative = (file: string) =>
  nativeFiles.has(file) || nativePrefixes.some((p) => file.startsWith(p));

// GitHub's PR files API stops listing at 3000 files.
const FILE_LIST_LIMIT = 3000;

export const affectedAreas = (
  event: string,
  files: readonly string[]
): Affected => {
  if (
    event !== "pull_request" ||
    files.length === 0 ||
    files.length >= FILE_LIST_LIMIT
  ) {
    return everything;
  }
  const affected = { native: false, web: false };
  for (const file of files) {
    if (file.startsWith(".github/")) {
      return everything;
    }
    if (isNative(file)) {
      affected.native = true;
    } else if (!isDocs(file)) {
      affected.web = true;
    }
  }
  return affected;
};

if (import.meta.main) {
  const input = await Bun.stdin.text();
  const files = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const { native, web } = affectedAreas(process.env.EVENT ?? "", files);
  process.stdout.write(`native=${native}\nweb=${web}\n`);
}
