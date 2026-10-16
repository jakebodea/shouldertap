/** Fail when wire-protocol constants drift between TS, Swift, and Rust. */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;

const read = (relative: string) =>
  readFileSync(path.join(root, "..", relative), "utf-8");

interface Swatch {
  label: string;
  base: string;
  ink: string;
}

export const parseTsSwatches = (source: string): Map<string, Swatch> => {
  const out = new Map<string, Swatch>();
  const block = source.match(
    /export const swatches[\s\S]*?= \{(?<body>[\s\S]*?)\n\};/u
  );
  if (!block?.groups?.body) {
    throw new Error("Could not find swatches in colors.ts");
  }
  const lineRe =
    /^\s*(?<name>\w+):\s*\{\s*label:\s*"(?<label>[^"]+)",\s*base:\s*"(?<base>[^"]+)",\s*ink:\s*"(?<ink>[^"]+)"\s*\},?/u;
  for (const line of block.groups.body.split("\n")) {
    const m = line.match(lineRe);
    if (m?.groups) {
      out.set(m.groups.name, {
        label: m.groups.label,
        base: m.groups.base.toLowerCase(),
        ink: m.groups.ink.toLowerCase(),
      });
    }
  }
  return out;
};

const parseSwiftSwatches = (source: string): Map<string, Swatch> => {
  const out = new Map<string, Swatch>();
  const re =
    /case \.(?<name>\w+): \("(?<label>[^"]+)", 0x(?<base>[0-9a-fA-F]+), 0x(?<ink>[0-9a-fA-F]+)\)/gu;
  for (const m of source.matchAll(re)) {
    if (!m.groups) {
      continue;
    }
    out.set(m.groups.name, {
      label: m.groups.label,
      base: `#${m.groups.base.toLowerCase()}`,
      ink: `#${m.groups.ink.toLowerCase()}`,
    });
  }
  return out;
};

export const parseRustSwatches = (source: string): Map<string, Swatch> => {
  const out = new Map<string, Swatch>();
  const re =
    /Self::(?<name>\w+) => \("(?<label>[^"]+)", 0x(?<base>[0-9a-fA-F]+), 0x(?<ink>[0-9a-fA-F]+)\)/gu;
  for (const m of source.matchAll(re)) {
    if (!m.groups) {
      continue;
    }
    const key = m.groups.name.toLowerCase();
    out.set(key, {
      label: m.groups.label,
      base: `#${m.groups.base.toLowerCase()}`,
      ink: `#${m.groups.ink.toLowerCase()}`,
    });
  }
  return out;
};

export const collectProtocolSyncErrors = (): string[] => {
  const ts = read("packages/domain/src/colors.ts");
  const swift = read("apps/macos/Sources/ShouldertapCore/Models.swift");
  const rust = read("apps/windows/core/src/models.rs");
  const iosProject = read("apps/ios/Shouldertap.xcodeproj/project.pbxproj");

  const tsSw = parseTsSwatches(ts);
  const swiftSw = parseSwiftSwatches(swift);
  const rustSw = parseRustSwatches(rust);
  const errors: string[] = [];

  for (const [name, tsEntry] of tsSw) {
    const swiftEntry = swiftSw.get(name);
    const rustEntry = rustSw.get(name);
    if (!swiftEntry) {
      errors.push(`Swift missing color ${name}`);
      continue;
    }
    if (!rustEntry) {
      errors.push(`Rust missing color ${name}`);
      continue;
    }
    for (const field of ["label", "base", "ink"] as const) {
      if (swiftEntry[field] !== tsEntry[field]) {
        errors.push(
          `${name}.${field}: TS ${tsEntry[field]} != Swift ${swiftEntry[field]}`
        );
      }
      if (rustEntry[field] !== tsEntry[field]) {
        errors.push(
          `${name}.${field}: TS ${tsEntry[field]} != Rust ${rustEntry[field]}`
        );
      }
    }
  }

  const swiftMaxTap = swift.match(/public let maxTapLength = (?<n>\d+)/u);
  const rustMaxTap = rust.match(/pub const MAX_TAP_LENGTH: usize = (?<n>\d+)/u);
  const swiftMaxReply = swift.match(/public let maxReplyLength = (?<n>\d+)/u);
  const rustMaxReply = rust.match(
    /pub const MAX_REPLY_LENGTH: usize = (?<n>\d+)/u
  );
  if (!(swiftMaxTap?.groups && rustMaxTap?.groups)) {
    errors.push("Could not read maxTapLength from Swift or Rust");
  } else if (swiftMaxTap.groups.n !== rustMaxTap.groups.n) {
    errors.push(
      `maxTapLength: Swift ${swiftMaxTap.groups.n} != Rust ${rustMaxTap.groups.n}`
    );
  }
  if (!(swiftMaxReply?.groups && rustMaxReply?.groups)) {
    errors.push("Could not read maxReplyLength from Swift or Rust");
  } else if (swiftMaxReply.groups.n !== rustMaxReply.groups.n) {
    errors.push(
      `maxReplyLength: Swift ${swiftMaxReply.groups.n} != Rust ${rustMaxReply.groups.n}`
    );
  }

  if (iosProject.includes("ShouldertapUITests")) {
    errors.push(
      "apps/ios still defines a ShouldertapUITests target; use swift test on ShouldertapCore instead"
    );
  }

  return errors;
};

if (import.meta.main) {
  const errors = collectProtocolSyncErrors();
  if (errors.length > 0) {
    console.error(
      `Protocol sync check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`
    );
    process.exit(1);
  }

  const colorCount = parseTsSwatches(
    read("packages/domain/src/colors.ts")
  ).size;
  console.log(
    `OK: ${colorCount} person colors and tap length limits match across Swift and Rust.`
  );
}
