import { parsePatronKey } from "@shouldertap/domain";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { DocPage, DocSection } from "@/components/document";
import { forgetIntent, patronPlan, resolveIntent } from "@/lib/account-flow";
import type { PatronPlan } from "@/lib/account-flow";
import { api } from "@/lib/api";
import { addPairing, inboxOf, loadPairings } from "@/lib/pairing";
import { loadPatronKey, savePatronKey } from "@/lib/sender-style";
import { useCheckoutEnabled } from "@/lib/use-patron";

const accountOrigin = import.meta.env.VITE_SERVER_URL;

interface Resource {
  id: string;
  name: string;
  kind: "sender" | "patron";
  inboxId?: string;
}

type Section = "browser" | "connections" | "patron";

/** A result line next to the action that caused it. */
const Notice = ({ children }: { children?: string }) =>
  children ? (
    <output className="text-ink block font-semibold">{children}</output>
  ) : null;

const Actions = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-3">{children}</div>
);

const leaveForStyle = () => {
  forgetIntent(localStorage);
};

const PatronPanel = ({
  plan,
  busy,
  canStyle,
  notice,
  onUse,
  onSave,
  onCheckout,
}: {
  plan: PatronPlan;
  busy: boolean;
  canStyle: boolean;
  notice?: string;
  onUse: (patronId: string) => void;
  onSave: () => void;
  onCheckout: () => void;
}) => {
  const style = canStyle ? (
    <a className="pill pill-ink" href="/style" onClick={leaveForStyle}>
      Continue to Style
    </a>
  ) : null;
  const manage = (
    <a
      className="pill"
      href={`${accountOrigin}/account?section=patron`}
      onClick={leaveForStyle}
    >
      Manage billing
    </a>
  );
  const body: Record<PatronPlan["kind"], ReactNode> = {
    here: (
      <>
        <p>Your membership is on this browser.</p>
        <Actions>
          {style}
          {manage}
        </Actions>
      </>
    ),
    use: (
      <>
        <p>Your account has a patron membership.</p>
        <Actions>
          <button
            className="pill pill-ink"
            disabled={busy}
            onClick={() => {
              if (plan.kind === "use") {
                onUse(plan.patronId);
              }
            }}
            type="button"
          >
            Use membership on this browser
          </button>
          {manage}
        </Actions>
      </>
    ),
    kept: (
      <>
        <p>
          This browser has a different membership from your account. It stays on
          this browser.
        </p>
        <Actions>
          <button
            className="pill"
            disabled={busy}
            onClick={onSave}
            type="button"
          >
            Save to my account
          </button>
          {style}
        </Actions>
      </>
    ),
    save: (
      <>
        <p>This browser has a membership that isn’t saved to your account.</p>
        <Actions>
          <button
            className="pill"
            disabled={busy}
            onClick={onSave}
            type="button"
          >
            Save to my account
          </button>
          {style}
        </Actions>
      </>
    ),
    checkout: (
      <>
        <p>
          Patrons can send their taps in a theme, to everyone they tap.
          $2/month, billed $24 annually.
        </p>
        <Actions>
          <button
            className="pill pill-ink"
            disabled={busy}
            onClick={onCheckout}
            type="button"
          >
            Continue to checkout
          </button>
        </Actions>
      </>
    ),
    soon: <p>Patron memberships open soon.</p>,
  };
  return (
    <DocSection title="Patron">
      {body[plan.kind]}
      <Notice>{notice}</Notice>
    </DocSection>
  );
};

const BrowserPanel = ({
  unsaved,
  busy,
  notice,
  onSave,
}: {
  unsaved: boolean;
  busy: boolean;
  notice?: string;
  onSave: () => void;
}) => (
  <DocSection title="On this browser">
    {unsaved ? (
      <>
        <p>Save this browser’s connections so you can restore them.</p>
        <Actions>
          <button
            className="pill"
            disabled={busy}
            onClick={onSave}
            type="button"
          >
            Save to my account
          </button>
        </Actions>
      </>
    ) : null}
    <Notice>{notice}</Notice>
  </DocSection>
);

const ConnectionsPanel = ({
  senders,
  isLocal,
  busy,
  loadError,
  hasPairings,
  notice,
  onRefresh,
  onRestore,
}: {
  senders: Resource[];
  isLocal: (resource: Resource) => boolean;
  busy: boolean;
  loadError: boolean;
  hasPairings: boolean;
  notice?: string;
  onRefresh: () => void;
  onRestore: (resource: Resource) => void;
}) => (
  <DocSection title="People you can tap">
    {loadError ? (
      <>
        <p>Connections couldn’t load.</p>
        <Actions>
          <button className="pill" onClick={onRefresh} type="button">
            Try again
          </button>
        </Actions>
      </>
    ) : (
      <div>
        {senders.map((resource) => (
          <div
            className="border-line flex items-center justify-between gap-4 border-b py-3"
            key={resource.id}
          >
            <strong className="min-w-0 break-words">Tap {resource.name}</strong>
            {isLocal(resource) ? (
              <span className="text-tone shrink-0 text-sm font-semibold">
                On this browser
              </span>
            ) : (
              <button
                className="pill pill-sm shrink-0"
                disabled={busy}
                onClick={() => {
                  onRestore(resource);
                }}
                type="button"
              >
                Use here
              </button>
            )}
          </div>
        ))}
        {senders.length ? null : <p>No saved connections yet.</p>}
      </div>
    )}
    <Notice>{notice}</Notice>
    {hasPairings ? (
      <Actions>
        <a className="pill" href="/tap">
          Continue to my taps
        </a>
      </Actions>
    ) : null}
  </DocSection>
);

const Account = () => {
  const { intent } = Route.useLoaderData();
  const [notices, setNotices] = useState<Partial<Record<Section, string>>>({});
  const notify = (section: Section, text: string) => {
    setNotices((current) => ({ ...current, [section]: text }));
  };
  const [busy, setBusy] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]);
  const [session, setSession] = useState<
    { email: string } | "loading" | "signed-out" | "error"
  >("loading");
  const [loadError, setLoadError] = useState(false);
  const checkoutEnabled = useCheckoutEnabled() ?? false;
  // Local credentials change under React's feet (restore writes storage).
  const [, setLocalVersion] = useState(0);
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

  const pairings = loadPairings();
  const patronKey = loadPatronKey(localStorage);
  const localPatronId = parsePatronKey(patronKey ?? "")?.patronId ?? null;
  const senders = resources.filter((r) => r.kind === "sender");
  const patrons = resources.filter((r) => r.kind === "patron");
  const plan = patronPlan({
    localPatronId,
    accountPatronIds: patrons.map((p) => p.id),
    checkoutEnabled,
  });
  const isLocal = (resource: Resource) =>
    pairings.some((pairing) => inboxOf(pairing.token) === resource.inboxId);
  const unsaved =
    pairings.some(
      (pairing) => !senders.some((s) => s.inboxId === inboxOf(pairing.token))
    ) ||
    (localPatronId !== null && !patrons.some((p) => p.id === localPatronId));

  const restore = async (resource: Resource) => {
    const section = resource.kind === "patron" ? "patron" : "connections";
    // Never replace a membership this browser already has.
    if (resource.kind === "patron" && patronKey) {
      notify(
        section,
        localPatronId === resource.id
          ? "Your membership is already on this browser."
          : "This browser already has another membership. It stays."
      );
      return;
    }
    if (resource.kind === "sender" && isLocal(resource)) {
      notify(section, "Already on this browser.");
      return;
    }
    setBusy(true);
    notify(section, "");
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
        notify(
          section,
          response.status === 401
            ? "Your sign-in expired. Sign in again."
            : "That couldn’t be added to this browser. Try again."
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
      setLocalVersion((n) => n + 1);
      notify(
        section,
        resource.kind === "patron"
          ? "Your membership is on this browser."
          : `You can tap ${resource.name} from this browser.`
      );
    } catch {
      notify(section, "Couldn’t reach Shouldertap. Try again.");
    }
    setBusy(false);
  };

  const save = async (section: Section, continueToBilling = false) => {
    setBusy(true);
    notify(section, "");
    try {
      const response = await fetch(`${accountOrigin}/account/adopt`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokens: pairings.map((pairing) => pairing.token),
          patronKey: patronKey ?? undefined,
        }),
      });
      if (!response.ok) {
        notify(
          section,
          response.status === 401
            ? "Your sign-in expired. Sign in again."
            : "This browser couldn’t be saved. Try again."
        );
        setBusy(false);
        return;
      }
      await refresh();
      notify(section, "Saved to your account.");
      if (continueToBilling) {
        window.location.assign(`${accountOrigin}/account?section=patron`);
        return;
      }
    } catch {
      notify(section, "Couldn’t reach Shouldertap. Try again.");
    }
    setBusy(false);
  };

  const patronSection = (
    <PatronPanel
      busy={busy}
      canStyle={pairings.length > 0}
      key="patron"
      notice={notices.patron}
      onCheckout={() => save("patron", true)}
      onSave={() => save("patron")}
      onUse={(patronId) => {
        const resource = patrons.find((p) => p.id === patronId);
        if (resource) {
          restore(resource);
        }
      }}
      plan={plan}
    />
  );

  const browserSection =
    unsaved || notices.browser ? (
      <BrowserPanel
        busy={busy}
        key="browser"
        notice={notices.browser}
        onSave={() => save("browser")}
        unsaved={unsaved}
      />
    ) : null;

  const connectionsSection = (
    <ConnectionsPanel
      busy={busy}
      hasPairings={pairings.length > 0}
      isLocal={isLocal}
      key="connections"
      loadError={loadError}
      notice={notices.connections}
      onRefresh={refresh}
      onRestore={restore}
      senders={senders}
    />
  );

  const signedIn = typeof session === "object";
  return (
    <DocPage
      intro={
        signedIn
          ? `Signed in as ${session.email}`
          : "Keep your connections and patron membership with you."
      }
      title={intent === "patron" ? "Patron." : "Your account."}
    >
      {session === "loading" ? (
        <output className="text-tone block py-8">Checking your sign-in…</output>
      ) : null}
      {session === "error" ? (
        <DocSection title="Couldn’t reach your account">
          <p>Check your connection and try again.</p>
          <Actions>
            <button className="pill" onClick={refresh} type="button">
              Try again
            </button>
          </Actions>
        </DocSection>
      ) : null}
      {session === "signed-out" ? (
        <DocSection title="Sign in by email">
          <p>
            {intent === "patron"
              ? "Sign in to restore your membership on this browser, or to become a patron."
              : "Sign in to save this browser’s connections and restore them on another device."}
          </p>
          <Actions>
            <a
              className="pill pill-ink"
              href={`${accountOrigin}/account${intent === "patron" ? "?section=patron" : ""}`}
            >
              Sign in
            </a>
          </Actions>
        </DocSection>
      ) : null}
      {signedIn ? (
        <>
          {intent === "patron"
            ? [patronSection, browserSection, connectionsSection]
            : [browserSection, connectionsSection, patronSection]}
          <div className="pt-6">
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

export const Route = createFileRoute("/account")({
  component: Account,
  // Read once per visit: the query, or an intent remembered before sign-in.
  loader: () => ({
    intent: resolveIntent(localStorage, window.location.search, Date.now()),
  }),
});
