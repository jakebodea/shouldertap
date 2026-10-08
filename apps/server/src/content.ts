/** A small safety baseline for private, invite-only messages, not a complete
 * moderation system. Reports and revocation remain necessary for context and
 * evasion this filter cannot detect. Nothing is sent to a moderation vendor. */
const blocked = [
  /\b(?:kill|murder|rape)\s+you\b/iu,
  /\b(?:kys|kill\s+yourself)\b/iu,
  /\b(?:nigg(?:er|a)s?|fagg?ots?)\b/iu,
  /\b(?:child\s+porn(?:ography)?|cp\s+for\s+sale)\b/iu,
];

export const isObjectionable = (text: string): boolean => {
  const normalized = text
    .normalize("NFKC")
    .replaceAll(/[\u200B-\u200D\uFEFF]/gu, "");
  return blocked.some((pattern) => pattern.test(normalized));
};
