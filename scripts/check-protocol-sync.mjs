#!/usr/bin/env node
/**
 * Prototype: fail when person-color swatches drift between TS, Swift, and Rust.
 * See docs/agent-friendly-plan.md on cursor/agent-friendly-plan-61f1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ts = readFileSync(join(root, "packages/domain/src/colors.ts"), "utf8");
const swift = readFileSync(
  join(root, "apps/macos/Sources/ShouldertapCore/Models.swift"),
  "utf8"
);
const rust = readFileSync(join(root, "apps/windows/core/src/models.rs"), "utf8");

/** @param {string} source */
const parseTsSwatches = (source) => {
  const out = new Map();
  const block = source.match(/export const swatches[\s\S]*?= \{([\s\S]*?)\n\};/);
  if (!block) {
    throw new Error("Could not find swatches in colors.ts");
  }
  for (const line of block[1].split("\n")) {
    const m = line.match(
      /^\s*(\w+):\s*\{\s*label:\s*"([^"]+)",\s*base:\s*"([^"]+)",\s*ink:\s*"([^"]+)"\s*\},?/
    );
    if (m) {
      out.set(m[1], { label: m[2], base: m[3].toLowerCase(), ink: m[4].toLowerCase() });
    }
  }
  return out;
};

/** @param {string} source */
const parseSwiftSwatches = (source) => {
  const out = new Map();
  const re =
    /case \.(\w+): \("([^"]+)", 0x([0-9a-fA-F]+), 0x([0-9a-fA-F]+)\)/g;
  for (const m of source.matchAll(re)) {
    out.set(m[1], {
      label: m[2],
      base: `#${m[3].toLowerCase()}`,
      ink: `#${m[4].toLowerCase()}`,
    });
  }
  return out;
};

/** @param {string} source */
const parseRustSwatches = (source) => {
  const out = new Map();
  const re =
    /Self::(\w+) => \("([^"]+)", 0x([0-9a-fA-F]+), 0x([0-9a-fA-F]+)\)/g;
  for (const m of source.matchAll(re)) {
    const key = m[1].toLowerCase();
    out.set(key, {
      label: m[2],
      base: `#${m[3].toLowerCase()}`,
      ink: `#${m[4].toLowerCase()}`,
    });
  }
  return out;
};

const tsSw = parseTsSwatches(ts);
const swiftSw = parseSwiftSwatches(swift);
const rustSw = parseRustSwatches(rust);

const errors = [];
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
  for (const field of ["label", "base", "ink"]) {
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

if (errors.length > 0) {
  console.error("Protocol sync check failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

console.log(`OK: ${tsSw.size} person colors match across TS, Swift, and Rust.`);
