import { swatches } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import type { CSSProperties } from "react";
import { useLayoutEffect } from "react";

/** CSS variables that paint a surface in a person's frame color. */
export const frameStyle = (color: PersonColor): CSSProperties =>
  ({
    "--frame": swatches[color].base,
    "--frame-ink": swatches[color].ink,
  }) as CSSProperties;

/**
 * Keep the browser toolbars in the frame color. Older Safari and Chrome read
 * theme-color; Safari also uses the document canvas and fixed edge surfaces.
 * Write both document backgrounds before paint, without restoring the initial
 * color between scene changes. Restore them only when the frame unmounts.
 */
export const useThemeColor = (color: string) => {
  useLayoutEffect(() => {
    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    const previous = metas.map((meta) => meta.content);
    const previousBody = document.body.style.backgroundColor;
    const previousHtml = document.documentElement.style.backgroundColor;
    return () => {
      for (const [i, meta] of metas.entries()) {
        meta.content = previous[i] ?? meta.content;
      }
      document.body.style.backgroundColor = previousBody;
      document.documentElement.style.backgroundColor = previousHtml;
    };
  }, []);

  useLayoutEffect(() => {
    for (const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]'
    )) {
      meta.content = color;
    }
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
  }, [color]);
};
