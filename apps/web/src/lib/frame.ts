import { type PersonColor, swatches } from "@shouldertap/domain";
import type { CSSProperties } from "react";
import { useEffect } from "react";

/** CSS variables that paint a surface in a person's frame color. */
export const frameStyle = (color: PersonColor): CSSProperties =>
  ({
    "--frame": swatches[color].base,
    "--frame-ink": swatches[color].ink,
  }) as CSSProperties;

/** Safari tints its toolbars from theme-color; keep them in the frame color. */
export const useThemeColor = (color: string) => {
  useEffect(() => {
    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    const previous = metas.map((meta) => meta.content);
    for (const meta of metas) {
      meta.content = color;
    }
    return () => {
      metas.forEach((meta, i) => {
        meta.content = previous[i] ?? meta.content;
      });
    };
  }, [color]);
};
