import type { TapTheme } from "@shouldertap/domain";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import "./tap-themes.css";
import { drawTap, loadThemeFonts } from "./themes";
import type { PreviewTap } from "./themes";

const CANVAS_WIDTH = 1440;

const useReducedMotion = () => {
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReduced(query.matches);
    };
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);
  return reduced;
};

/**
 * A live, scaled-down recipient display showing one tap in one theme, drawn
 * by the same composition and motion the recipient's computer uses. Each
 * change of `replay` plays the arrival again. Decorative for assistive tech:
 * callers label it.
 */
export const TapPreview = ({
  theme,
  tap,
  replay,
  className = "",
}: {
  theme: TapTheme;
  tap: PreviewTap;
  replay: number;
  className?: string;
}) => {
  const screen = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [fontsReady, setFontsReady] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    let live = true;
    const load = async () => {
      await loadThemeFonts();
      if (live) {
        setFontsReady(true);
      }
    };
    load();
    return () => {
      live = false;
    };
  }, []);

  useLayoutEffect(() => {
    const host = screen.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setScale(host.clientWidth / CANVAS_WIDTH);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Arrival plays on first draw, on every theme change and on Replay. Text
  // edits redraw in place, so typing doesn't restart the motion.
  const played = useRef("");
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!(target && fontsReady && scale > 0)) {
      return;
    }
    const key = `${theme}:${replay}`;
    drawTap(target, theme, tap, {
      animate: played.current !== key,
      reduced,
    });
    played.current = key;
  }, [fontsReady, scale, theme, tap, replay, reduced]);

  return (
    <div aria-hidden="true" className={`tp-screen ${className}`} ref={screen}>
      <div
        className="tp-canvas"
        ref={canvas}
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
};
