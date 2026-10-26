import type { QuickReplies, ResponseKind, Tap, TapResponse } from "./contracts";
import { MAX_QUICK_REPLY_LENGTH } from "./contracts";

export const responsePresets: readonly {
  kind: Exclude<ResponseKind, "text">;
  label: string;
}[] = [
  { kind: "on_it", label: "On it" },
  { kind: "in_10", label: "In 10 min" },
];

/** What a tap offers when its sender didn't change anything. */
export const DEFAULT_QUICK_REPLIES: QuickReplies = ["On it", "In 10 min"];

export const describeResponse = (response: TapResponse): string => {
  switch (response.kind) {
    case "on_it": {
      return "On it";
    }
    case "in_10": {
      return "In 10 min";
    }
    case "text": {
      return response.text?.trim() || "Replied";
    }
    default: {
      return "Responded";
    }
  }
};

/**
 * The two one-tap answers a recipient sees on a tap, in order, with the
 * response each one sends. A tap without its own replies offers the presets;
 * a sender's own reply goes back as text, so the sender sees its label on any
 * client.
 */
export const quickRepliesFor = (
  tap: Pick<Tap, "replies">
): readonly { label: string; response: TapResponse }[] =>
  tap.replies
    ? tap.replies.map((label) => ({
        label,
        response: { kind: "text", text: label },
      }))
    : responsePresets.map(({ kind, label }) => ({
        label,
        response: { kind },
      }));

/**
 * Tidies two replies typed by a sender: trimmed, each 1 to
 * `MAX_QUICK_REPLY_LENGTH` characters, and different from each other. Returns
 * null when they are the defaults (the tap needn't carry them), or an error
 * message to show.
 */
export const normalizeQuickReplies = (
  replies: readonly string[]
): { replies: QuickReplies | null } | { error: string } => {
  const [first, second] = replies.map((reply) => reply.trim());
  if (replies.length !== 2 || !first || !second) {
    return { error: "Write both reply options" };
  }
  if (
    first.length > MAX_QUICK_REPLY_LENGTH ||
    second.length > MAX_QUICK_REPLY_LENGTH
  ) {
    return {
      error: `Keep each reply option to ${MAX_QUICK_REPLY_LENGTH} characters`,
    };
  }
  if (first.toLowerCase() === second.toLowerCase()) {
    return { error: "Make the two reply options different" };
  }
  return first === DEFAULT_QUICK_REPLIES[0] &&
    second === DEFAULT_QUICK_REPLIES[1]
    ? { replies: null }
    : { replies: [first, second] };
};
