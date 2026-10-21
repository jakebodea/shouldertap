import type { ReactNode } from "react";

import { Mark } from "@/components/mark";

/** Public pages use the full paper canvas; Frame belongs to the sender UI. */
export const SitePage = ({ children }: { children: ReactNode }) => (
  <div className="bg-paper text-ink min-h-svh px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-10">
    <div className="mx-auto max-w-5xl">
      <header>
        <a
          aria-label="Shouldertap home"
          className="inline-flex min-h-11 items-center gap-2 text-xl font-extrabold tracking-[-0.035em]"
          href="/"
        >
          <Mark className="size-6" />
          Shouldertap
        </a>
      </header>
      {children}
    </div>
  </div>
);
