import { type RefObject, useLayoutEffect, useRef } from "react";

import { wipeEdgeCoverage } from "@/lib/wipe";

const blend = (from: string, to: string, amount: number) => {
  const channels = [1, 3, 5].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16);
    const end = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(start + (end - start) * amount);
  });
  return `rgb(${channels.join(", ")})`;
};

/** Safari extends solid fixed edge colors into its native browser chrome. */
export function WipeEdges({
  frame,
  from,
  to,
}: {
  frame: RefObject<HTMLDivElement | null>;
  from: string;
  to: string;
}) {
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    let request = 0;
    const paint = () => {
      const root = frame.current;
      if (!(root && top.current && bottom.current)) {
        return;
      }
      // Read the actual eased radius, so pausing, resizing and interrupting the
      // wipe also control the bars. There is no second animation clock.
      const radius = Number.parseFloat(
        getComputedStyle(root).getPropertyValue("--wipe")
      );
      const { width, height } = root.getBoundingClientRect();
      top.current.style.backgroundColor = blend(
        from,
        to,
        wipeEdgeCoverage(radius, width, 0)
      );
      bottom.current.style.backgroundColor = blend(
        from,
        to,
        wipeEdgeCoverage(radius, width, height)
      );
      if (from !== to) {
        request = requestAnimationFrame(paint);
      }
    };
    paint();
    return () => cancelAnimationFrame(request);
  }, [frame, from, to]);

  return (
    <>
      <div
        aria-hidden="true"
        className="wipe-edge wipe-edge-top"
        ref={top}
        style={{ backgroundColor: from }}
      />
      <div
        aria-hidden="true"
        className="wipe-edge wipe-edge-bottom"
        ref={bottom}
        style={{ backgroundColor: from }}
      />
    </>
  );
}
