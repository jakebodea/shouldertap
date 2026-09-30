import * as Schema from "effect/Schema";

/**
 * Every sender picks one of these when they pair. The recipient sees that
 * color as the frame around their tap, so a household can tell who is
 * tapping from across the room. Clients share the exact values from here.
 */
export const PersonColor = Schema.Literals([
  "moss",
  "cobalt",
  "plum",
  "tomato",
  "ochre",
  "rose",
  "sky",
  "graphite",
]);
export type PersonColor = typeof PersonColor.Type;

export interface Swatch {
  /** The frame. */
  readonly base: string;
  /** Text and icons set directly on the frame. */
  readonly ink: string;
  readonly label: string;
}

export const swatches: Readonly<Record<PersonColor, Swatch>> = {
  moss: { label: "Moss", base: "#1f5a3d", ink: "#f4f1e8" },
  cobalt: { label: "Cobalt", base: "#2340c8", ink: "#f2f3fb" },
  plum: { label: "Plum", base: "#6d2657", ink: "#f8eef3" },
  tomato: { label: "Tomato", base: "#d9432b", ink: "#fff4ef" },
  ochre: { label: "Ochre", base: "#e8b022", ink: "#1f1a0e" },
  rose: { label: "Rose", base: "#f2c4bd", ink: "#3b1219" },
  sky: { label: "Sky", base: "#9cc9ec", ink: "#0d2233" },
  graphite: { label: "Graphite", base: "#2b2c30", ink: "#f1f1ee" },
};

export const personColors = PersonColor.literals;

/** A stable color for senders who paired before colors existed. */
export const fallbackColor = (id: string): PersonColor => {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2_147_483_647;
  }
  return personColors[hash % personColors.length] ?? "cobalt";
};
