import { parsePatronKey } from "@shouldertap/domain";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { DocPage, DocSection } from "@/components/document";
import { api } from "@/lib/api";
import { addPairing, inboxOf, loadPairings } from "@/lib/pairing";
import { loadPatronKey, savePatronKey } from "@/lib/sender-style";

const accountOrigin = import.meta.env.VITE_SERVER_URL;

interface Resource {
  id: string;
  name: string;
  kind: "sender" | "patron";
  inboxId?: string;
}
const Account = () => {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]);
  const [session, setSession] = useState<
    { email: string } | "loading" | "signed-out" | "error"
  >("loading");
  const [loadError, setLoadError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${accountOrigin}/api/auth/get-session`, {
        credentials: "include",
      });
      if (!response.ok) {
        setSession("error");
        return;
      }
      const auth = (await response.json()) as {
        user?: { email: string };
      } | null;
      if (!auth?.user) {
        setSession("signed-out");
        setResources([]);
        return;
      }
      const saved = await fetch(`${accountOrigin}/account/data`, {
        credentials: "include",
      });
      setSession({ email: auth.user.email });
      if (!saved.ok) {
        setLoadError(true);
        return;
      }
      const data = (await saved.json()) as {
        senders: Omit<Resource, "kind">[];
        patrons: Omit<Resource, "kind">[];
      };
      setResources([
        ...data.senders.map((item) => ({ ...item, kind: "sender" as const })),
        ...data.patrons.map((item) => ({ ...item, kind: "patron" as const })),
      ]);
      setLoadError(false);
    } catch {
      setSession("error");
    }
  }, []);
  useEffect(() => {
    // A session read and account snapshot are external system boundaries.
    // oxlint-disable-next-line react/set-state-in-effect -- state changes happen after network requests
    refresh();
    const wake = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
  }, [refresh]);
  const restore = async (resource: Resource) => {
    if (
      resource.kind === "sender" &&
      loadPairings().some(
        (pairing) => inboxOf(pairing.token) === resource.inboxId
      )
    ) {
      setMessage("This browser already has a connection to that inbox.");
      return;
    }
    if (resource.kind === "patron" && loadPatronKey(localStorage)) {
      const sameMembership =
        parsePatronKey(loadPatronKey(localStorage) || "")?.patronId ===
        resource.id;
      setMessage(
        sameMembership
          ? "This membership is already on this browser. Continue to Style to use your themes."
          : "This browser already has another patron membership. Your existing membership has been kept."
      );
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${accountOrigin}/account/restore`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: resource.kind,
          id: resource.id,
          deviceName: "Web browser",
        }),
      });
      if (!response.ok) {
        setMessage(
          "This connection could not be restored. Sign in again and retry."
        );
        setBusy(false);
        return;
      }
      const grant = (await response.json()) as {
        key?: string;
        token?: string;
        credentialId: string;
        recipientName: string;
      };
      if (resource.kind === "patron" && grant.key) {
        savePatronKey(localStorage, grant.key);
      } else if (grant.token) {
        const snapshot = await api.withToken(grant.token).me();
        if (snapshot.kind === "sender") {
          addPairing({
            token: grant.token,
            credentialId: grant.credentialId,
            recipientName: grant.recipientName,
            senderName: snapshot.senderName,
            color: snapshot.senderColor,
          });
        }
      }
      setMessage(
        resource.kind === "patron"
          ? "Membership added to this browser. Continue to Style to use your themes."
          : "Connection added to this browser. Continue to your taps to send a message."
      );
    } catch {
      setMessage("Could not restore this connection. Please try again.");
    }
    setBusy(false);
  };
  const save = async (continueToBilling = false) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${accountOrigin}/account/adopt`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokens: loadPairings().map((pairing) => pairing.token),
          patronKey: loadPatronKey(localStorage) ?? undefined,
        }),
      });
      if (response.status === 401) {
        setMessage(
          "Sign in to your account first, then return here and try again."
        );
        setBusy(false);
        return;
      }
      if (!response.ok) {
        setMessage("Your connections could not be saved. Please try again.");
        setBusy(false);
        return;
      }
      setMessage("Your connections are saved to your account.");
      await refresh();
      if (continueToBilling) {
        window.location.assign(`${accountOrigin}/account?section=patron`);
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not reach Shouldertap. Please try again."
      );
    }
    setBusy(false);
  };
  const signedIn = typeof session === "object";
  const pairings = loadPairings();
  const patronKey = loadPatronKey(localStorage);
  const isLocal = (resource: Resource) =>
    resource.kind === "patron"
      ? parsePatronKey(patronKey || "")?.patronId === resource.id
      : pairings.some((pairing) => inboxOf(pairing.token) === resource.inboxId);
  return (
    <DocPage
      title="Your account."
      intro={
        signedIn
          ? `Signed in as ${session.email}`
          : "Keep your connections and patron support with you."
      }
    >
      <output className="block" aria-live="polite">
        {session === "loading" ? "Checking your sign-in…" : message}
      </output>
      {session === "error" ? (
        <DocSection title="Could not reach your account">
          <p>Check your connection and try again.</p>
          <div>
            <button className="pill" type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        </DocSection>
      ) : null}
      {session === "signed-out" ? (
        <DocSection title="Sign in by email">
          <p>
            Your saved connections and patron membership will be available here
            after you sign in.
          </p>
          <div>
            <a className="pill pill-ink" href={`${accountOrigin}/account`}>
              Sign in
            </a>
          </div>
        </DocSection>
      ) : null}
      {signedIn ? (
        <>
          {pairings.length > 0 || patronKey ? (
            <DocSection title="On this browser">
              <p>
                Save your existing connections and membership to this account.
              </p>
              <div>
                <button
                  className="pill"
                  type="button"
                  disabled={busy}
                  onClick={() => save()}
                >
                  Save this browser
                </button>
              </div>
            </DocSection>
          ) : null}
          <DocSection title="Your connections">
            {loadError ? (
              <>
                <p>Connections could not load.</p>
                <div>
                  <button className="pill" type="button" onClick={refresh}>
                    Try again
                  </button>
                </div>
              </>
            ) : null}
            {loadError
              ? null
              : resources.map((resource) => (
                  <div
                    className="border-line flex flex-wrap items-center justify-between gap-4 border-t py-4"
                    key={resource.kind + resource.id}
                  >
                    <div>
                      <strong>{resource.name}</strong>
                      <p className="text-tone text-sm">
                        {resource.kind === "patron"
                          ? "Patron membership"
                          : "Sender connection"}
                      </p>
                    </div>
                    {isLocal(resource) ? (
                      <span className="text-tone text-sm">On this browser</span>
                    ) : (
                      <button
                        className="pill"
                        type="button"
                        disabled={busy}
                        onClick={() => restore(resource)}
                      >
                        Use on this browser
                      </button>
                    )}
                  </div>
                ))}
            {!loadError && !resources.length ? (
              <p>No saved connections yet.</p>
            ) : null}
            {pairings.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                <a className="pill" href="/tap">
                  Continue to my taps
                </a>
                {patronKey ? (
                  <a className="pill pill-ink" href="/style">
                    Continue to Style
                  </a>
                ) : null}
              </div>
            ) : null}
          </DocSection>
          <DocSection title="Patron support">
            <p>
              Core messaging is free. Continue to view your membership and
              available billing options.
            </p>
            <div>
              <button
                className="pill"
                type="button"
                disabled={busy}
                onClick={() => save(true)}
              >
                Continue to patron support
              </button>
            </div>
          </DocSection>
          <div>
            <a
              className="text-tone inline-flex min-h-11 items-center underline underline-offset-4"
              href={`${accountOrigin}/account`}
            >
              Account settings
            </a>
          </div>
        </>
      ) : null}
    </DocPage>
  );
};

export const Route = createFileRoute("/account")({ component: Account });
