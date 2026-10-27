/**
 * Fail when the Mac and Windows apps stop offering the same features. Each
 * desktop feature is listed by the label a person sees; both apps must carry
 * that label as a string literal. Add a feature to both apps, then list it here.
 * A `{placeholder}` stands for an interpolation: Swift `\(…)`, Rust `{…}`.
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
    "Help keep Shouldertap free.",
    "Become a patron",
    "Maybe later",
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
    "Check for Updates…",
    "Quit",
  ],
  send: [
    "How they see you",
    "They'll see you as",
    "Use for them",
    "Use these for every tap",
    "Reset",
    "Tap style for {name}",
    "How your taps look on {name}'s screens. They never pay to see it.",
    "Your taps to {name} use {theme}.",
    "How {name} sees it",
    "Patron themes",
    "Replay",
    "Enjoying Shouldertap?",
    "Not now",
  ],
  settings: [
    "Can tap you",
    "Your devices",
    "Accessibility",
    "Tap motion",
    "Account",
    "Sign out",
    "Sign in on your phone",
    "Reply options",
    "Use On it and In 10 min",
    "Patron themes",
    "Manage billing",
    "Choose tap style",
    "Patron memberships open soon.",
    "Sign in to become a patron.",
    "App",
    "Open at login",
  ],
} as const;

export interface MissingLabel {
  label: string;
  missingFrom: "Mac" | "Windows" | "Mac and Windows";
}

const PLACEHOLDER = /\{[^{}]+\}/gu;
const SWIFT_INTERPOLATION = String.raw`\\\((?:[^()]|\([^()]*\))*\)`;
const RUST_INTERPOLATION = String.raw`\{[^{}"]*\}`;

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** The label as one whole string literal, its placeholders written as
 * `interpolation` (Swift `\(…)`, Rust `{…}`). */
const hasLiteral = (source: string, label: string, interpolation: string) => {
  if (label.split(PLACEHOLDER).length === 1) {
    return source.includes(JSON.stringify(label));
  }
  const pattern = label
    .split(PLACEHOLDER)
    .map((part) => escapeRegExp(JSON.stringify(part).slice(1, -1)))
    .join(interpolation);
  return new RegExp(`"${pattern}"`, "u").test(source);
};

/** Every label one of the apps doesn't carry, in list order. */
export const missingLabels = (
  labels: readonly string[],
  sources: { mac: string; windows: string }
): MissingLabel[] =>
  labels.flatMap((label): MissingLabel[] => {
    const mac = hasLiteral(sources.mac, label, SWIFT_INTERPOLATION);
    const windows = hasLiteral(sources.windows, label, RUST_INTERPOLATION);
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
