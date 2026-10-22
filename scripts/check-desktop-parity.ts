/**
 * Fail when the Mac and Windows apps stop offering the same features. Each
 * desktop feature is listed by the label a person sees; both apps must carry
 * that label as a string literal. Add a feature to both apps, then list it here.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Labels both desktop apps show, by surface. Platform words (Mac, PC, menu bar, tray) stay out. */
export const desktopLabels = {
  welcome: [
    "Welcome to Shouldertap.",
    "Get started",
    "Later",
    "I have an account",
    "What's your email?",
    "We'll send you a code to sign in. No password to remember.",
    "Send code",
    "Check your email.",
    "Resend",
    "Change email",
    "What should people call you?",
    "Continue",
    "Open the menu",
    "Sign in with your phone",
    "Sign in with your phone.",
    "Show a new code",
    "Use your email instead",
    "Waiting for your iPhone…",
  ],
  menu: [
    "Invite someone",
    "Copy link",
    "Send",
    "Got a link? Paste it",
    "Received",
    "Taps you receive show up here.",
    "Settings",
    "Done",
    "Quit",
  ],
  settings: [
    "Can tap you",
    "Your devices",
    "Accessibility",
    "Tap motion",
    "Account",
    "Sign out",
    "Sign in on your phone",
    "App",
    "Open at login",
    "Check for Updates…",
  ],
} as const;

export interface MissingLabel {
  label: string;
  missingFrom: "Mac" | "Windows" | "Mac and Windows";
}

const hasLiteral = (source: string, label: string) =>
  source.includes(JSON.stringify(label));

/** Every label one of the apps doesn't carry, in list order. */
export const missingLabels = (
  labels: readonly string[],
  sources: { mac: string; windows: string }
): MissingLabel[] =>
  labels.flatMap((label): MissingLabel[] => {
    const mac = hasLiteral(sources.mac, label);
    const windows = hasLiteral(sources.windows, label);
    if (mac && windows) {
      return [];
    }
    if (mac) {
      return [{ label, missingFrom: "Windows" }];
    }
    return [{ label, missingFrom: windows ? "Mac" : "Mac and Windows" }];
  });

const root = path.join(import.meta.dirname, "..");

const readTree = (relative: string, extension: string): string =>
  readdirSync(path.join(root, relative), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(extension))
    .map((file) => readFileSync(path.join(root, relative, file), "utf-8"))
    .join("\n");

if (import.meta.main) {
  const missing = missingLabels(Object.values(desktopLabels).flat(), {
    mac: readTree("apps/macos/Sources/Shouldertap", ".swift"),
    windows: readTree("apps/windows/app/src", ".rs"),
  });
  if (missing.length > 0) {
    for (const { label, missingFrom } of missing) {
      console.error(`"${label}" is missing from ${missingFrom}`);
    }
    console.error(
      "Desktop parity check failed: the Mac and Windows apps ship the same features. Add it to both (apps/macos, apps/windows), or update scripts/check-desktop-parity.ts."
    );
    process.exit(1);
  }
  console.log("OK: Mac and Windows offer the same desktop features.");
}
