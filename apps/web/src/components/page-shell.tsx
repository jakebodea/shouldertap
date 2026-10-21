import type { CSSProperties, ReactNode, Ref } from "react";

/** One viewport frame and paper scroller for every web surface. */
export const PageShell = ({
  children,
  header,
  backdrop,
  className = "",
  style,
  ref,
}: {
  children: ReactNode;
  header: ReactNode;
  backdrop?: ReactNode;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}) => (
  <div
    className={`page-shell text-frame-ink ${className}`}
    ref={ref}
    style={style}
  >
    {backdrop}
    <header className="page-shell-header relative z-10 flex items-center gap-6 text-[0.9375rem] font-semibold md:text-lg">
      {header}
    </header>
    <div className="page-shell-paper bg-paper text-ink relative z-10 min-h-0 overflow-y-auto overscroll-contain">
      {children}
    </div>
  </div>
);
