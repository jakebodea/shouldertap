import { createFileRoute, redirect } from "@tanstack/react-router";

import { Landing } from "@/components/landing";
import { loadPairing } from "@/lib/pairing";

// A home-screen icon saved before the composer moved to /tap still opens "/",
// so a launched web app goes straight to the composer. In a browser tab, "/"
// stays the landing page for everyone.
const launchedFromHomeScreen = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  ("standalone" in navigator && navigator.standalone === true);

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (launchedFromHomeScreen() && loadPairing()) {
      throw redirect({ to: "/tap", replace: true });
    }
  },
  component: Landing,
});
