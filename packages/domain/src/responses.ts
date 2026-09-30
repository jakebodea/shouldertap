import type { ResponseKind, TapResponse } from "./contracts";

export const responsePresets: ReadonlyArray<{
  kind: Exclude<ResponseKind, "text">;
  label: string;
}> = [
  { kind: "on_it", label: "✅ On it" },
  { kind: "in_10", label: "⏱️ In 10 min" },
];

export const describeResponse = (response: TapResponse): string => {
  switch (response.kind) {
    case "on_it":
      return "✅ On it";
    case "in_10":
      return "⏱️ In 10 min";
    case "text":
      return `💬 ${response.text ?? ""}`.trim();
    default:
      return "Responded";
  }
};

export const quickTaps: readonly string[] = [
  "Dinner's ready",
  "Can you come here?",
  "Call me",
  "Take out the trash",
];
