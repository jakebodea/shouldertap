import type { PersonColor } from "@shouldertap/domain";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";
import { SignIn } from "@/components/sign-in";
import { loadSession } from "@/lib/account";
import { safeRedirect } from "@/lib/onboarding";

const SignInPage = () => {
  const { session } = Route.useRouteContext();
  const { redirect: next } = Route.useSearch();
  const navigate = useNavigate();
  const [color, setColor] = useState<PersonColor>("cobalt");
  return (
    <Frame color={color}>
      <Mark className="size-9" />
      <SignIn
        color={color}
        me={session.kind === "signed-in" ? session.me : null}
        onColor={setColor}
        onDone={() => {
          navigate({ href: next, replace: true });
        }}
      />
    </Frame>
  );
};

/** Email → code → you; then back to where the person was headed. */
export const Route = createFileRoute("/signin")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: async ({ search }) => {
    const session = await loadSession();
    if (session.kind === "signed-in" && session.me.profile) {
      throw redirect({ href: search.redirect, replace: true });
    }
    return { session };
  },
  component: SignInPage,
});
