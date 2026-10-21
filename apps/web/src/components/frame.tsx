import type { PersonColor } from "@shouldertap/domain";
import type { ReactNode } from "react";

import { SitePage } from "@/components/site-page";

/** Sender content uses the same full-width shell as the public pages. */
export const Frame = ({
  color,
  children,
}: {
  color: PersonColor;
  children: ReactNode;
}) => (
  <SitePage color={color}>
    <main className="flex flex-col gap-6">{children}</main>
  </SitePage>
);
