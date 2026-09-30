import { ApiError } from "@shouldertap/client";
import { MAX_NAME_LENGTH } from "@shouldertap/domain";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { api } from "@/lib/api";
import { loadPairing, savePairing } from "@/lib/pairing";

export const Route = createFileRoute("/join")({
  component: JoinComponent,
});

// The invite code travels in the URL fragment so it never reaches a server log.
const LEADING_HASH = /^#/;
const readCode = () =>
  decodeURIComponent(window.location.hash.replace(LEADING_HASH, "")).trim();

function JoinComponent() {
  const navigate = useNavigate();
  const [code] = useState(readCode);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = loadPairing();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const grant = await api.redeemInvite({ code, name: name.trim() });
      if (grant.kind !== "sender") {
        setError(
          "That code is for pairing another Mac. Enter it in the Shouldertap Mac app."
        );
        return;
      }
      savePairing({
        token: grant.token,
        credentialId: grant.credentialId,
        senderName: name.trim(),
        recipientName: grant.recipientName,
      });
      history.replaceState(null, "", "/join");
      navigate({ to: "/" });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code !== "network"
          ? caught.message
          : "Couldn't reach Shouldertap. Check your connection and try again."
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <img alt="" className="size-14" height={56} src="/icon.svg" width={56} />
      {code ? (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="font-semibold text-3xl tracking-tight">
              You're invited
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              Pair this device to send Shouldertaps. They'll see your name on
              their screen.
            </p>
          </div>
          {existing ? (
            <p className="rounded-2xl border bg-card p-4 text-sm">
              This device already sends taps to {existing.recipientName}.
              Pairing again replaces that.
            </p>
          ) : null}
          <form className="flex flex-col gap-3" onSubmit={onSubmit}>
            <label className="font-medium text-sm" htmlFor="sender-name">
              Your name
            </label>
            <input
              autoComplete="given-name"
              className="h-12 rounded-2xl border bg-card px-4 text-base outline-none focus:ring-2 focus:ring-tap/40"
              id="sender-name"
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Sam"
              value={name}
            />
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <button
              className="h-12 rounded-2xl bg-tap font-semibold text-base text-tap-foreground transition active:scale-[0.98] disabled:opacity-40"
              disabled={pending || !name.trim()}
              type="submit"
            >
              {pending ? "Pairing…" : "Pair this device"}
            </button>
          </form>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <h1 className="font-semibold text-3xl tracking-tight">
            Missing invite
          </h1>
          <p className="text-lg text-muted-foreground">
            Open the full invite link you were sent. It ends with a long code
            after “#”.
          </p>
        </div>
      )}
    </main>
  );
}
