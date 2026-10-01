/** Fraction of a horizontal edge reached by the circle at the top-left. */
export const wipeEdgeCoverage = (
  radius: number,
  width: number,
  y: number
): number => {
  if (width <= 0 || radius <= y) {
    return 0;
  }
  return Math.min(1, Math.sqrt(radius * radius - y * y) / width);
};
