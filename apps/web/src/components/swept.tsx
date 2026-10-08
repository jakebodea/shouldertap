import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

const SWEEP_MS = 760;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Content that changes with the landing sweep. When `id` changes, the old
 * and new content stack in place and the same circle that recolors the frame
 * reveals the new content as it passes, instead of it swapping instantly.
 * The circle is centered on the viewport's corner, so each instance measures
 * where it sits and offsets its mask to match.
 */
export const Swept = ({
  id,
  children,
  className,
}: {
  id: string | number;
  children: ReactNode;
  className?: string;
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<{
    id: string | number;
    node: ReactNode;
    previous: ReactNode | null;
  }>({ id, node: children, previous: null });

  if (state.id !== id) {
    setState({
      id,
      node: children,
      previous: prefersReducedMotion() ? null : state.node,
    });
  }

  useLayoutEffect(() => {
    if (state.previous === null) {
      return;
    }
    const el = ref.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--ox", `${-rect.left}px`);
      el.style.setProperty("--oy", `${-rect.top}px`);
    }
    const timer = setTimeout(() => {
      setState((s) => ({ ...s, previous: null }));
    }, SWEEP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state.previous]);

  const sweeping = state.previous !== null;
  const layer: CSSProperties = { gridArea: "1 / 1" };

  return (
    <span className={`inline-grid ${className ?? ""}`} ref={ref}>
      {sweeping ? (
        <span aria-hidden="true" className="sweep-out" style={layer}>
          {state.previous}
        </span>
      ) : null}
      <span className={sweeping ? "sweep-in" : undefined} style={layer}>
        {children}
      </span>
    </span>
  );
};
