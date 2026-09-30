import { type PersonColor, swatches } from "@shouldertap/domain";
import type { CSSProperties } from "react";
import { useEffect } from "react";

/** CSS variables that paint a surface in a person's frame color. */
export const frameStyle = (color: PersonColor): CSSProperties =>
  ({
    "--frame": swatches[color].base,
    "--frame-ink": swatches[color].ink,
  }) as CSSProperties;

/**
 * Keep the browser toolbars in the frame color. Older Safari and Chrome read
 * theme-color; Safari 26 ignores it and samples body's background instead,
 * updating live only on a direct inline write.
 */
export const useThemeColor = (color: string) => {
  useEffect(() => {
    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    const previous = metas.map((meta) => meta.content);
    const previousBody = document.body.style.backgroundColor;
    for (const meta of metas) {
      meta.content = color;
    }
    document.body.style.backgroundColor = color;
    return () => {
      metas.forEach((meta, i) => {
        meta.content = previous[i] ?? meta.content;
      });
      document.body.style.backgroundColor = previousBody;
    };
  }, [color]);
};
