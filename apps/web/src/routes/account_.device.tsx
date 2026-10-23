import { ApiError } from "@shouldertap/client";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";
import { StepHeading } from "@/components/sign-in";
import {
  account,
  isSignedOutError,
  loadSession,
  needsSignIn,
} from "@/lib/account";
import { failureMessage } from "@/lib/onboarding";

const DEVICES: Record<string, string> = {
  "shouldertap-ios": "iPhone",
  "shouldertap-mac": "Mac",
  "shouldertap-windows": "PC",
  "shouldertap-web": "browser",
};

type Phase =
  | { readonly kind: "loading" }
  | {
      readonly kind: "asking";
      readonly userCode: string;
      readonly device: string;
    }
  | { readonly kind: "approved"; readonly device: string }
  | { readonly kind: "denied" }
  /** Expired, already answered, or not a code for a Shouldertap app. */
  | { readonly kind: "stale" };

/** Typed by hand when the page opened without a code. */
const EnterCode = ({ onCode }: { onCode: (code: string) => void }) => {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCode(code.trim().toUpperCase());
  };
  return (
    <>
      <StepHeading title="Connect a device">
        Type the code your Mac, PC or browser shows.
      </StepHeading>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <input
          aria-label="Code"
          autoCapitalize="characters"
          autoComplete="off"
          className="bg-faint min-h-13 rounded-2xl px-4 text-center text-2xl font-extrabold tracking-[0.12em]"
          maxLength={32}
          onChange={(event) => {
            setCode(event.target.value);
          }}
          required
          value={code}
        />
        <button className="pill pill-frame w-full" type="submit">
          Continue
        </button>
      </form>
    </>
  );
};

/**
 * A computer showed a sign-in QR code (device authorization) and this
 * browser opened it, signed in. Asks which device it is and shows the code
 * to check against the screen; nothing is approved on load.
 */
const ConnectDevice = ({ userCode }: { userCode: string }) => {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const review = async () => {
      let next: Phase;
      try {
        const found = await account.reviewDeviceSignIn(userCode);
        const device = DEVICES[found.client];
        next =
          found.pending && device
            ? { kind: "asking", userCode: found.userCode, device }
            : { kind: "stale" };
      } catch (error) {
        if (isSignedOutError(error)) {
          window.location.reload();
          return;
        }
        if (
          !(error instanceof ApiError && error.status < 500 && error.status)
        ) {
          setFailure(failureMessage(error));
        }
        next = { kind: "stale" };
      }
      if (!cancelled) {
        setPhase(next);
      }
    };
    // The code's state is an external system boundary.
    // oxlint-disable-next-line react/set-state-in-effect -- state changes happen after network requests
    review();
    return () => {
      cancelled = true;
    };
  }, [userCode]);

  if (phase.kind === "loading") {
    return <output className="text-tone block py-8">Checking the code…</output>;
  }
  if (phase.kind === "approved" || phase.kind === "denied") {
    return (
      <StepHeading
        title={
          phase.kind === "approved"
            ? `Go back to your ${phase.device}`
            : "Nothing was connected"
        }
      >
        {phase.kind === "approved"
          ? "It's signed in to your account."
          : "The request was turned away."}
      </StepHeading>
    );
  }
  if (phase.kind === "stale") {
    return (
      <>
        <StepHeading title="That code is gone">
          {failure ??
            "Sign-in codes last 10 minutes and work once. Start again on your device."}
        </StepHeading>
        <Link className="pill pill-frame w-full" to="/account">
          Go to your account
        </Link>
      </>
    );
  }

  const answer = async (approve: boolean) => {
    setPending(true);
    setFailure(null);
    try {
      await (approve
        ? account.approveDeviceSignIn(phase.userCode)
        : account.denyDeviceSignIn(phase.userCode));
      setPhase(
        approve
          ? { kind: "approved", device: phase.device }
          : { kind: "denied" }
      );
    } catch (error) {
      setFailure(failureMessage(error));
      setPending(false);
    }
  };
  return (
    <>
      <StepHeading title={`Sign in on your ${phase.device}?`}>
        Only approve a code on a device you have with you. Never approve a code
        someone sent you.
      </StepHeading>
      <p className="bg-faint rounded-2xl px-5 py-4 text-center text-[2.5rem] font-extrabold tracking-[0.12em] tabular-nums">
        {phase.userCode}
      </p>
      <div className="flex flex-col gap-3">
        {failure ? (
          <p className="text-destructive text-[0.9375rem]" role="alert">
            {failure}
          </p>
        ) : null}
        <button
          className="pill pill-frame w-full"
          disabled={pending}
          onClick={() => answer(true)}
          type="button"
        >
          Sign in
        </button>
        <button
          className="pill w-full"
          disabled={pending}
          onClick={() => answer(false)}
          type="button"
        >
          Not me
        </button>
      </div>
    </>
  );
};

const DevicePage = () => {
  const { user_code: fromLink } = Route.useSearch();
  const [userCode, setUserCode] = useState(fromLink);
  return (
    <Frame color={Route.useRouteContext().color}>
      <Mark className="size-9" />
      {userCode ? (
        <ConnectDevice key={userCode} userCode={userCode} />
      ) : (
        <EnterCode onCode={setUserCode} />
      )}
    </Frame>
  );
};

/** `/account/device?user_code=…`: where a device's sign-in QR code leads. */
export const Route = createFileRoute("/account_/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code:
      typeof search.user_code === "string" ? search.user_code : undefined,
  }),
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (needsSignIn(session)) {
      throw redirect({
        to: "/signin",
        search: { redirect: location.href },
        replace: true,
      });
    }
    // Offline: the code check below says so.
    return {
      color:
        (session.kind === "signed-in" && session.me.profile?.color) || "cobalt",
    };
  },
  component: DevicePage,
});
