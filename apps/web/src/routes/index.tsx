import { createFileRoute, redirect } from "@tanstack/react-router";

import { Landing } from "@/components/landing";
import { isStandalone } from "@/lib/install";
import { loadPairing } from "@/lib/pairing";

// A home-screen icon saved before the composer moved to /tap still opens "/",
// so a launched web app goes to the composer, or to pairing when it has none.
// In a browser tab, "/" stays the landing page for everyone.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (isStandalone()) {
      throw redirect({ to: loadPairing() ? "/tap" : "/join", replace: true });
    }
  },
  component: Landing,
});
