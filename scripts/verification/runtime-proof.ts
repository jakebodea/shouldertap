import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { digest } from "./environment";

export interface RuntimeProof {
  head: string;
  baseSha: string;
  sourceDigest: string;
  verdict: string;
  cleaned: boolean;
  limitations?: string[];
  scenario: string;
  results: { name: string; exitCode: number }[];
  artifacts: { path: string; sha256: string }[];
}

export const validateRuntimeProof = (
  receipt: RuntimeProof,
  head: string,
  base: string
) => {
  if (
    receipt.head !== head ||
    receipt.baseSha !== base ||
    receipt.sourceDigest !== digest("")
  ) {
    throw new Error(
      "Runtime evidence is not bound to the clean committed source"
    );
  }
  if (receipt.verdict !== "PASS" || receipt.cleaned !== true) {
    throw new Error("Runtime evidence did not pass and clean up");
  }
  const required = [
    "protocol",
    "preview-smoke",
    receipt.scenario === "core" ? "native-core" : "browser",
  ];
  if (
    !["core", "browser"].includes(receipt.scenario) ||
    required.some(
      (name) =>
        !receipt.results.some(
          (result) => result.name === name && result.exitCode === 0
        )
    ) ||
    receipt.results.some((result) => result.exitCode !== 0)
  ) {
    throw new Error(
      "Runtime evidence is missing successful required execution"
    );
  }
  if (receipt.artifacts.length === 0) {
    throw new Error("Runtime evidence has no artifacts");
  }
  return receipt;
};

const inside = (directory: string, relative: string) => {
  const result = path.resolve(directory, relative);
  if (
    path.isAbsolute(relative) ||
    !result.startsWith(`${directory}${path.sep}`)
  ) {
    throw new Error("Runtime artifact escapes its bundle");
  }
  return result;
};

export const validateRuntimeFiles = (
  filename: string,
  head: string,
  base: string
) => {
  const directory = path.dirname(path.resolve(filename));
  const receipt = validateRuntimeProof(
    JSON.parse(readFileSync(filename, "utf-8")) as RuntimeProof,
    head,
    base
  );
  for (const artifact of receipt.artifacts) {
    if (
      digest(readFileSync(inside(directory, artifact.path))) !== artifact.sha256
    ) {
      throw new Error(`Runtime artifact changed: ${artifact.path}`);
    }
  }
  return receipt;
};

export const importRuntimeProof = (
  filename: string,
  proofDirectory: string,
  head: string,
  base: string
) => {
  const receipt = validateRuntimeFiles(filename, head, base);
  const destination = path.join(proofDirectory, "runtime");
  mkdirSync(destination, { recursive: true });
  copyFileSync(filename, path.join(destination, "receipt.json"));
  for (const artifact of receipt.artifacts) {
    const output = inside(destination, artifact.path);
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(
      inside(path.dirname(path.resolve(filename)), artifact.path),
      output
    );
  }
  return {
    receipt,
    bundle: {
      path: "runtime/receipt.json",
      sha256: digest(readFileSync(filename)),
    },
  };
};
