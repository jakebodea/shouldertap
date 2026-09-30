import { type PersonColor, swatches } from "@shouldertap/domain";
import type { ReactNode } from "react";

import { frameStyle, useThemeColor } from "@/lib/frame";

/**
 * The sender's own color frames their screen; the app lives on the paper
 * page inside it. The frame follows the safe areas so it reads edge to edge.
 */
export function Frame({
  color,
  children,
}: {
  color: PersonColor;
  children: ReactNode;
}) {
  useThemeColor(swatches[color].base);
  return (
    <div
      className="min-h-svh bg-frame px-[9px] pt-[max(9px,env(safe-area-inset-top))] pb-[max(9px,env(safe-area-inset-bottom))] transition-colors duration-500"
      style={frameStyle(color)}
    >
      <main className="mx-auto flex min-h-[calc(100svh-18px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full max-w-xl flex-col gap-6 rounded-[2.25rem] bg-paper px-[22px] pt-7 pb-6 text-ink">
        {children}
      </main>
    </div>
  );
}
