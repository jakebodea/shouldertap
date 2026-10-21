import { swatches } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import type { ReactNode } from "react";

import { Mark } from "@/components/mark";
import { PageShell } from "@/components/page-shell";
import { FrameSafariEdgeStrips } from "@/components/safari-edge-strips";
import { frameStyle, useThemeColor } from "@/lib/frame";

export const SitePage = ({
  children,
  color = "moss",
}: {
  children: ReactNode;
  color?: PersonColor;
}) => {
  useThemeColor(swatches[color].base);
  return (
    <PageShell
      backdrop={<FrameSafariEdgeStrips />}
      className="bg-frame transition-colors duration-500"
      header={
        <a
          aria-label="Shouldertap home"
          className="inline-flex min-h-11 items-center gap-[0.32em] text-xl font-extrabold tracking-[-0.035em] md:text-[1.625rem]"
          href="/"
        >
          <Mark className="size-[1.05em]" />
          Shouldertap
        </a>
      }
      style={frameStyle(color)}
    >
      <div className="mx-auto max-w-[90rem] px-6 py-10 md:px-[72px] md:py-16">
        {children}
      </div>
    </PageShell>
  );
};
