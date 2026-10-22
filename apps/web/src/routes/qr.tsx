import { ApiError } from "@shouldertap/client";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";
import { StepHeading } from "@/components/sign-in";
import { account } from "@/lib/account";
import { failureMessage } from "@/lib/onboarding";
import { appLink, qrTokenFromFragment } from "@/lib/qr-sign-in";

/**
 * A phone's camera opened a sign-in QR code from a computer
 * (`/qr#<token>`). Hand it to the iPhone app, or sign this browser in; never
 * on load, so a link preview can't spend the code.
 */
const QrPage = () => {
  const navigate = useNavigate();
  // The token rides in the fragment so it never reaches a server log; read it
  // once, then take it out of the address bar and history.
  const [token, setToken] = useState(() =>
    qrTokenFromFragment(window.location.hash)
  );
  useEffect(() => {
    if (window.location.hash) {
      history.replaceState(null, "", "/qr");
    }
  }, []);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const signInHere = async () => {
    if (!token) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await account.redeemQrSignIn(token, "web");
      // The sign-in page asks for a name and color if the account has none,
      // and otherwise goes straight on to the account.
      navigate({
        to: "/signin",
        search: { redirect: "/account" },
        replace: true,
      });
    } catch (error) {
      setPending(false);
      // Used or expired: say so plainly, with nothing left to press.
      if (error instanceof ApiError && error.status === 400) {
        setToken(null);
        return;
      }
      setFailure(failureMessage(error));
    }
  };

  if (!token) {
    return (
      <Frame color="cobalt">
        <Mark className="size-9" />
        <StepHeading title="That code is gone">
          Sign-in codes work once. Show a new one on your computer and scan it
          again.
        </StepHeading>
        <Link className="pill pill-frame w-full" to="/">
          Go to Shouldertap
        </Link>
      </Frame>
    );
  }

  return (
    <Frame color="cobalt">
      <Mark className="size-9" />
      <StepHeading title="Sign in on this phone">
        Your computer is showing a code to sign in to your Shouldertap account.
        It works once, for 2 minutes.
      </StepHeading>
      <div className="flex flex-col gap-3">
        {failure ? (
          <p className="text-destructive text-[0.9375rem]" role="alert">
            {failure}
          </p>
        ) : null}
        <a className="pill pill-frame w-full" href={appLink(token)}>
          Open in the Shouldertap app
        </a>
        <button
          className="pill w-full"
          disabled={pending}
          onClick={signInHere}
          type="button"
        >
          {pending ? "Signing in…" : "Sign in this browser instead"}
        </button>
      </div>
    </Frame>
  );
};

export const Route = createFileRoute("/qr")({
  component: QrPage,
});
