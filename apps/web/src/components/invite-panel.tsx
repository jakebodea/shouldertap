import { Copy01Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { encode } from "uqr";

import { StepHeading } from "@/components/sign-in";
import { account } from "@/lib/account";
import { failureMessage, inviteLink } from "@/lib/onboarding";

/** A scannable QR code, always dark on white so every camera reads it. */
export const InviteQr = ({ value }: { value: string }) => {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 0 });
    let d = "";
    for (const [y, row] of qr.data.entries()) {
      for (const [x, dark] of row.entries()) {
        if (dark) {
          d += `M${x} ${y}h1v1h-1z`;
        }
      }
    }
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <div className="w-full max-w-[16rem] self-center rounded-[18px] bg-white p-4 shadow-[inset_0_0_0_1px_var(--line)] sm:self-start">
      <svg
        aria-hidden="true"
        className="block h-auto w-full"
        shapeRendering="crispEdges"
        viewBox={`-1 -1 ${size + 2} ${size + 2}`}
      >
        <path d={path} fill="#161616" />
      </svg>
    </div>
  );
};

type State =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly link: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "failed"; readonly message: string };

const expiry = (expiresAt: number) =>
  new Date(expiresAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const copy = async (link: string) => {
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copied");
  } catch {
    toast.error("Couldn't copy. Select the link and copy it.");
  }
};
const share = async (link: string) => {
  try {
    await navigator.share({ title: "Tap me on Shouldertap", url: link });
  } catch {
    // Dismissed: nothing to do.
  }
};

/**
 * "Invite someone": a fresh invite from the account, shared as a link and a
 * QR code. Whoever accepts it can tap you, and you them.
 */
export const InvitePanel = ({ onDone }: { onDone: () => void }) => {
  const [state, setState] = useState<State>({ kind: "loading" });
  const create = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const invite = await account.createInvite();
      setState({
        kind: "ready",
        link: inviteLink(window.location.origin, invite.code),
        expiresAt: invite.expiresAt,
      });
    } catch (error) {
      setState({ kind: "failed", message: failureMessage(error) });
    }
  }, []);
  useEffect(() => {
    // Creating the invite is a request to the API, an external system.
    // oxlint-disable-next-line react/set-state-in-effect -- state changes after the request
    create();
  }, [create]);

  const canShare = typeof navigator.share === "function";
  return (
    <>
      <StepHeading title="Invite someone">
        Send them this link, or let them scan the code. Once they accept, you
        can tap each other.
      </StepHeading>
      {state.kind === "loading" ? (
        <output className="text-tone block py-8 text-center">
          Making your invite…
        </output>
      ) : null}
      {state.kind === "failed" ? (
        <div className="flex flex-col gap-3">
          <p className="text-destructive text-[0.9375rem]" role="alert">
            {state.message}
          </p>
          <button className="pill w-full" onClick={create} type="button">
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <InviteQr value={state.link} />
          <div className="flex flex-col gap-2">
            <p className="bg-faint rounded-[18px] px-4 py-3 text-[0.9375rem] leading-snug font-semibold break-all select-all">
              {state.link}
            </p>
            <p className="text-tone text-[0.8125rem]">
              Expires {expiry(state.expiresAt)}.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            {canShare ? (
              <button
                className="pill pill-frame w-full sm:w-auto"
                onClick={() => share(state.link)}
                type="button"
              >
                <HugeiconsIcon className="size-5" icon={Share08Icon} />
                Share link
              </button>
            ) : null}
            <button
              className={`pill w-full sm:w-auto ${canShare ? "" : "pill-frame"}`}
              onClick={() => copy(state.link)}
              type="button"
            >
              <HugeiconsIcon className="size-5" icon={Copy01Icon} />
              Copy link
            </button>
          </div>
        </>
      ) : null}
      <button
        className="text-tone self-center text-[0.9375rem] underline underline-offset-[3px]"
        onClick={onDone}
        type="button"
      >
        Done
      </button>
    </>
  );
};
