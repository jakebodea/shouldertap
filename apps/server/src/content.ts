/** A small safety baseline for private, invite-only messages, not a complete
 * moderation system. Reports and revocation remain necessary for context and
 * evasion this filter cannot detect. Nothing is sent to a moderation vendor. */
const blocked = [
  /\b(?:kill|murder|rape)\s+you\b/i,
  /\b(?:kys|kill\s+yourself)\b/i,
  /\b(?:nigg(?:er|a)s?|fagg?ots?)\b/i,
  /\b(?:child\s+porn(?:ography)?|cp\s+for\s+sale)\b/i,
];

export const isObjectionable = (text: string): boolean => {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  return blocked.some((pattern) => pattern.test(normalized));
};
