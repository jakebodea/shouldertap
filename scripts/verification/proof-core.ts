import { createHash } from "node:crypto";
import path from "node:path";

import { Schema } from "effect";

export const riskTiers = ["low", "medium", "high", "critical"] as const;
export type RiskTier = (typeof riskTiers)[number];
export const riskTierSchema = Schema.Literals(riskTiers);

export const verdicts = ["PASS", "PASS_WITH_NOTES", "FAIL", "BLOCKED"] as const;
export type Verdict = (typeof verdicts)[number];

const riskRank: Record<RiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const criticalPath =
  /^(?:\.github\/workflows\/|stacks\/|apps\/server\/(?:account-migrations\/|drizzle|src\/(?:account-|verification-|Server\.ts|qr-sign-in))|scripts\/verification\/)/u;
const highPath =
  /^(?:apps\/(?:server|macos|ios|windows)\/|packages\/(?:domain|client)\/|package\.json$|bun\.lock$|alchemy\.)/u;
const mediumPath = /^(?:apps\/web\/|scripts\/|turbo\.json$|tsconfig\.json$)/u;
const visibleSourcePath =
  /^apps\/(?:web\/src|macos\/Sources\/Shouldertap|ios\/Shouldertap|windows\/app\/src)\/.*\.(?:css|tsx|swift|rs|png|svg)$/u;
const publicAssetPath = /^apps\/web\/public\//u;
const testPath = /(?:^|\/)\S+\.test\.[cm]?[jt]sx?$/u;

export const classifyPath = (changedPath: string): RiskTier => {
  if (criticalPath.test(changedPath)) {
    return "critical";
  }
  if (highPath.test(changedPath)) {
    return "high";
  }
  if (mediumPath.test(changedPath)) {
    return "medium";
  }
  return "low";
};

export const classifyChangedFiles = (paths: readonly string[]): RiskTier => {
  let highest: RiskTier = "low";
  for (const changedPath of paths) {
    const candidate = classifyPath(changedPath);
    if (riskRank[candidate] > riskRank[highest]) {
      highest = candidate;
    }
  }
  return highest;
};

export const maxRiskTier = (first: RiskTier, second: RiskTier): RiskTier =>
  riskRank[first] >= riskRank[second] ? first : second;

export const requiresVisualEvidence = (paths: readonly string[]): boolean =>
  paths.some(
    (changedPath) =>
      (visibleSourcePath.test(changedPath) ||
        publicAssetPath.test(changedPath)) &&
      !testPath.test(changedPath)
  );

const text = Schema.NonEmptyString;
const sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const list = <Item extends Schema.Top>(item: Item) =>
  Schema.mutable(Schema.Array(item));

export const proofArtifactSchema = Schema.Struct({
  alt: text,
  kind: Schema.Literals(["image", "video"]),
  path: text,
  sha256: sha256Hex,
});

export const proofCommandSchema = Schema.Struct({
  command: text,
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  exitCode: Schema.Int,
  logPath: text,
  name: text,
  sha256: sha256Hex,
  status: Schema.Literals(["pass", "fail"]),
});

export const independentVerificationSchema = Schema.Struct({
  source: text,
  summary: text,
  verdict: Schema.Literals(["PASS", "PASS_WITH_NOTES"]),
});

export const proofReceiptSchema = Schema.Struct({
  artifacts: list(proofArtifactSchema),
  base: Schema.Struct({ ref: text, sha: text }),
  changedFiles: list(text).check(Schema.isMinLength(1)),
  commands: list(proofCommandSchema).check(Schema.isMinLength(1)),
  createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/u)),
  flows: list(text),
  focusedChecks: list(proofCommandSchema),
  headSha: text,
  independentVerification: Schema.NullOr(independentVerificationSchema),
  notes: list(text),
  patchId: text,
  requiresVisualEvidence: Schema.Boolean,
  riskTier: riskTierSchema,
  rollback: Schema.NullOr(text),
  runtimeBundle: Schema.NullOr(
    Schema.Struct({ path: text, sha256: sha256Hex })
  ),
  schemaVersion: Schema.Literal(1),
  verdict: Schema.Literals(verdicts),
});

export type ProofArtifact = typeof proofArtifactSchema.Type;
export type ProofCommand = typeof proofCommandSchema.Type;
export type ProofReceipt = typeof proofReceiptSchema.Type;

const canonicalGates: Record<string, string> = {
  ci: "bun run ci",
  build: "bun run build",
  runtime: "bun run verify -- --local --scenario core",
};

const canonicalCommand = (name: string, risk: RiskTier) =>
  name === "runtime" && risk === "medium"
    ? "bun run verify -- --local --scenario browser"
    : canonicalGates[name];

export const expectedCommandNames = (
  riskTier: RiskTier,
  ciPassed: boolean,
  buildPassed: boolean
): string[] => {
  if (riskTier === "low" || !ciPassed) {
    return ["ci"];
  }
  return buildPassed ? ["ci", "build", "runtime"] : ["ci", "build"];
};

const arraysEqual = (first: readonly string[], second: readonly string[]) =>
  first.length === second.length &&
  first.every((value, index) => value === second[index]);

export const deriveVerdict = (
  receipt: Pick<
    ProofReceipt,
    | "artifacts"
    | "commands"
    | "focusedChecks"
    | "independentVerification"
    | "notes"
    | "requiresVisualEvidence"
    | "riskTier"
    | "rollback"
    | "runtimeBundle"
  >
): Verdict => {
  if (
    [...receipt.commands, ...receipt.focusedChecks].some(
      (command) => command.status === "fail" || command.exitCode !== 0
    )
  ) {
    return "FAIL";
  }
  if (
    receipt.commands.some(
      (command) =>
        canonicalCommand(command.name, receipt.riskTier) !== command.command
    )
  ) {
    return "FAIL";
  }
  const ciPassed = receipt.commands[0]?.status === "pass";
  const buildPassed = receipt.commands[1]?.status === "pass";
  if (
    !arraysEqual(
      receipt.commands.map((command) => command.name),
      expectedCommandNames(receipt.riskTier, ciPassed, buildPassed)
    )
  ) {
    return "BLOCKED";
  }
  if (receipt.riskTier !== "low" && receipt.runtimeBundle === null) {
    return "BLOCKED";
  }
  if (receipt.requiresVisualEvidence && receipt.artifacts.length === 0) {
    return "BLOCKED";
  }
  if (
    (receipt.riskTier === "high" || receipt.riskTier === "critical") &&
    receipt.independentVerification === null
  ) {
    return "BLOCKED";
  }
  if (receipt.riskTier === "critical" && receipt.rollback === null) {
    return "BLOCKED";
  }
  if (receipt.riskTier === "critical" && receipt.focusedChecks.length === 0) {
    return "BLOCKED";
  }
  if (
    receipt.notes.length > 0 ||
    receipt.independentVerification?.verdict === "PASS_WITH_NOTES"
  ) {
    return "PASS_WITH_NOTES";
  }
  return "PASS";
};

export interface ReceiptFacts {
  changedFiles: string[];
  minimumRiskTier: RiskTier;
  requiresVisualEvidence: boolean;
}

export const validateReceiptSemantics = (
  receipt: ProofReceipt,
  facts: ReceiptFacts
): string[] => {
  const violations: string[] = [];
  if (!arraysEqual(receipt.changedFiles, facts.changedFiles)) {
    violations.push("changed files do not match the proved revision");
  }
  if (
    maxRiskTier(receipt.riskTier, facts.minimumRiskTier) !== receipt.riskTier
  ) {
    violations.push("risk tier is lower than the changed paths require");
  }
  if (receipt.requiresVisualEvidence !== facts.requiresVisualEvidence) {
    violations.push("visual-evidence requirement does not match changed paths");
  }
  const ciPassed = receipt.commands[0]?.status === "pass";
  const buildPassed = receipt.commands[1]?.status === "pass";
  const commandNames = receipt.commands.map((command) => command.name);
  if (
    !arraysEqual(
      commandNames,
      expectedCommandNames(receipt.riskTier, ciPassed, buildPassed)
    )
  ) {
    violations.push("recorded gates do not match the risk tier and CI result");
  }
  for (const command of receipt.commands) {
    const expectedCommand = canonicalCommand(command.name, receipt.riskTier);
    if (command.command !== expectedCommand) {
      violations.push(`${command.name} command is not the canonical gate`);
    }
    if ((command.exitCode === 0) !== (command.status === "pass")) {
      violations.push(`${command.name} status contradicts its exit code`);
    }
  }
  for (const command of receipt.focusedChecks) {
    if ((command.exitCode === 0) !== (command.status === "pass")) {
      violations.push(`${command.name} status contradicts its exit code`);
    }
  }
  if (receipt.verdict !== deriveVerdict(receipt)) {
    violations.push("verdict contradicts the recorded evidence");
  }
  return violations;
};

export const sha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

export const artifactKindForPath = (
  artifactPath: string
): "image" | "video" => {
  const extension = path.extname(artifactPath).toLowerCase();
  if ([".mp4", ".mov", ".webm"].includes(extension)) {
    return "video";
  }
  if ([".gif", ".jpeg", ".jpg", ".png", ".webp"].includes(extension)) {
    return "image";
  }
  throw new Error(`Proof artifact must be an image or video: ${artifactPath}`);
};

export const githubAttachmentArgument = (
  artifactPath: string,
  artifact: Pick<ProofArtifact, "alt" | "kind">
): string =>
  artifact.kind === "image" ? `${artifactPath}#${artifact.alt}` : artifactPath;

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

export const renderProofReport = (receipt: ProofReceipt): string => {
  const commands = [...receipt.commands, ...receipt.focusedChecks]
    .map(
      (command) =>
        `| ${escapeCell(command.name)} | ${command.status} | \`${escapeCell(command.command)}\` | ${command.durationMs} ms |`
    )
    .join("\n");
  const artifacts =
    receipt.artifacts.length === 0
      ? "- None required or captured."
      : receipt.artifacts
          .map(
            (artifact) =>
              `- ${artifact.kind}: ${artifact.alt} (SHA-256 \`${artifact.sha256}\`)`
          )
          .join("\n");
  const flows =
    receipt.flows.length === 0
      ? "- No interactive flow was claimed."
      : receipt.flows.map((flow) => `- ${flow}`).join("\n");
  const notes =
    receipt.notes.length === 0
      ? "- None."
      : receipt.notes.map((note) => `- ${note}`).join("\n");
  const independentVerification = receipt.independentVerification
    ? `- ${receipt.independentVerification.verdict} by ${receipt.independentVerification.source}: ${receipt.independentVerification.summary}`
    : "- Not recorded.";
  const rollback = receipt.rollback ?? "Not required or not recorded.";

  return `<!-- proofed-delivery:${receipt.headSha} -->
## Verification proof: ${receipt.verdict}

Bound to head \`${receipt.headSha}\`, base \`${receipt.base.sha}\`, and stable patch \`${receipt.patchId}\`.

Risk: **${receipt.riskTier}**${receipt.requiresVisualEvidence ? " · visual evidence required" : ""}

| Gate | Result | Command | Duration |
| --- | --- | --- | --- |
${commands}

### Verified flows

${flows}

### Evidence

${artifacts}

### Independent verification

${independentVerification}

### Rollback

${rollback}

### Limitations and notes

${notes}
`;
};
