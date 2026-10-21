import type { TapTheme } from "@shouldertap/domain";

/** What the sender sees each theme called. */
export const THEME_NAMES: Record<TapTheme, { name: string; sub: string }> = {
  default: { name: "Default", sub: "The calm Frame. Free" },
  broadsheet: { name: "Broadsheet", sub: "Your tap as a front page" },
  billboard: { name: "Billboard", sub: "A poster in your color" },
  terminal: { name: "Terminal", sub: "A phosphor console" },
  note: { name: "Note", sub: "Handwritten, taped down" },
};
