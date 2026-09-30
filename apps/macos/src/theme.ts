import { fallbackColor, type PersonColor, swatches } from "@shouldertap/domain";

/**
 * Bricolage Grotesque, bundled as static instances (see
 * macos/Shouldertap-macOS/Fonts). Referenced by PostScript name, so never
 * combine these with `fontWeight`.
 */
export const fonts = {
  /** 500, optical size 24: text and UI on the overlay. */
  medium: "BricolageGrotesque-Medium",
  /** 700, optical size 36: names, pills, titles. */
  bold: "BricolageGrotesque-Bold",
  /** 800, optical size 96: the message. */
  extraBold: "BricolageGrotesque-ExtraBold",
};

/** The paper world inside every frame (DESIGN.md, "Color"). */
export const paper = {
  paper: "#f6f5f1",
  faint: "#ebe9e3",
  line: "#dedcd5",
  tone: "#6f6e69",
  ink: "#161616",
};

export const live = "#2f9e5b";

/** A sender's swatch; senders who paired before colors existed get a stable one. */
export const swatchFor = (color: PersonColor | null, id: string) =>
  swatches[color ?? fallbackColor(id)];
