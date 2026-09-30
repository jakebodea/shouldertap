import type { SVGProps } from "react";

/**
 * The Shouldertap mark: a frame whose top-right corner is a round shoulder,
 * with three knock marks landing on it. `knocking` plays the double knock.
 */
export function Mark({
  knocking = false,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { knocking?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={[knocking ? "knocking" : "", className]
        .filter(Boolean)
        .join(" ")}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="-2.5 -8.65 44.65 44.65"
      {...props}
    >
      <path
        d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z"
        strokeWidth={5}
      />
      <path
        className="knock-mark"
        d="M26.8 -3.08L29.19 -9.65"
        strokeWidth={3.75}
        style={{ transformOrigin: "23.4px 6.6px" }}
      />
      <path
        className="knock-mark"
        d="M30.63 -0.63L35.58 -5.58"
        strokeWidth={3.75}
        style={{ transformOrigin: "23.4px 6.6px" }}
      />
      <path
        className="knock-mark"
        d="M33.08 3.2L39.65 0.81"
        strokeWidth={3.75}
        style={{ transformOrigin: "23.4px 6.6px" }}
      />
    </svg>
  );
}

export function Wordmark({
  className,
  knocking,
}: {
  className?: string;
  knocking?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-[0.32em] font-extrabold tracking-[-0.035em] ${className ?? ""}`}
    >
      <Mark className="size-[1.05em]" knocking={knocking} />
      Shouldertap
    </span>
  );
}
