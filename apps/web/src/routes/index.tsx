import { createFileRoute, redirect } from "@tanstack/react-router";

import { Landing } from "@/components/landing";
import { isStandalone } from "@/lib/install";

// A launched Home Screen app has no landing page to show: it opens the
// composer, whose guard sends a signed-out person to sign-in first. In a
// browser tab, "/" stays the landing page for everyone.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (isStandalone()) {
      throw redirect({ to: "/tap", replace: true });
    }
  },
  component: Landing,
});
