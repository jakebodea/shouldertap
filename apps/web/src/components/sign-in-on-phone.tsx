import { useCallback, useEffect, useState } from "react";

import { DocSection } from "@/components/document";
import { QrCode } from "@/components/qr-code";
import { account, isSignedOutError } from "@/lib/account";
import { failureMessage } from "@/lib/onboarding";
import {
  afterQrStatus,
  afterQrStatusFailed,
  QR_STATUS_EVERY_MS,
  signedInOn,
} from "@/lib/qr-sign-in";
import type { ShowQr } from "@/lib/qr-sign-in";

type State = ShowQr | { readonly kind: "idle" };

/**
 * "Sign in on your phone": a one-time QR code, made on demand, that the
 * iPhone app scans to sign in to this account. Checks every 2 seconds
 * whether it was used, and stops when it was, when it expires, or when the
 * page goes away.
 */
export const SignInOnPhone = ({ onSignedOut }: { onSignedOut: () => void }) => {
  const [state, setState] = useState<State>({ kind: "idle" });

  const make = useCallback(async () => {
    setState({ kind: "making" });
    try {
      setState({ kind: "showing", qr: await account.createQrSignIn() });
    } catch (error) {
      if (isSignedOutError(error)) {
        onSignedOut();
        return;
      }
      setState({ kind: "failed", message: failureMessage(error) });
    }
  }, [onSignedOut]);

  const showing = state.kind === "showing" ? state : null;
  useEffect(() => {
    if (!showing) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      let next: ShowQr;
      try {
        next = afterQrStatus(
          showing,
          await account.qrSignInStatus(showing.qr.token)
        );
      } catch {
        next = afterQrStatusFailed(showing, Date.now());
      }
      if (cancelled) {
        return;
      }
      if (next === showing) {
        timer = setTimeout(check, QR_STATUS_EVERY_MS);
      } else {
        setState(next);
      }
    };
    timer = setTimeout(check, QR_STATUS_EVERY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [showing]);

  return (
    <DocSection title="Sign in on your phone">
      {state.kind === "idle" ? (
        <>
          <p>
            Show a code here and scan it with the Shouldertap app on your
            iPhone. No email needed.
          </p>
          <div className="flex flex-wrap gap-3">
            <button className="pill pill-ink" onClick={make} type="button">
              Sign in on your phone
            </button>
          </div>
        </>
      ) : null}
      {state.kind === "making" ? (
        <output className="text-tone block py-8">Making your code…</output>
      ) : null}
      {state.kind === "showing" ? (
        <>
          <QrCode value={state.qr.url} />
          <p>
            Scan with the Shouldertap app on your iPhone. Works once, for 2
            minutes.
          </p>
        </>
      ) : null}
      {state.kind === "used" ? (
        <output className="text-ink block font-semibold">
          {signedInOn(state.platform)}.
        </output>
      ) : null}
      {state.kind === "expired" || state.kind === "failed" ? (
        <>
          <p className="font-semibold" role="alert">
            {state.kind === "failed"
              ? state.message
              : "That code expired. Show a new one to scan."}
          </p>
          <div className="flex flex-wrap gap-3">
            <button className="pill pill-ink" onClick={make} type="button">
              Show a new code
            </button>
          </div>
        </>
      ) : null}
    </DocSection>
  );
};
