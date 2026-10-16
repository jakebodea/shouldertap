/**
 * Fixed strips at the viewport edge so mobile Safari tints its chrome from
 * the frame color. See `.safari-edge` in index.css.
 */
export const FrameSafariEdgeStrips = () => (
  <>
    <div
      aria-hidden="true"
      className="safari-edge frame-edge-top bg-frame transition-colors duration-500"
    />
    <div
      aria-hidden="true"
      className="safari-edge frame-edge-bottom bg-frame transition-colors duration-500"
    />
  </>
);
