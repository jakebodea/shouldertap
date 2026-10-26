import { ApiError } from "@shouldertap/client";
import type { Me } from "@shouldertap/client";
import { parsePatronKey } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { DocPage, DocSection } from "@/components/document";
import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";
import { ProfileFields, SignIn } from "@/components/sign-in";
import { SignInOnPhone } from "@/components/sign-in-on-phone";
import { account, isSignedOutError, loadSession } from "@/lib/account";
import type { Session } from "@/lib/account";
import {
  forgetIntent,
  membershipChoices,
  patronPlan,
  resolveIntent,
} from "@/lib/account-flow";
import type { PatronPlan } from "@/lib/account-flow";
import { failureMessage } from "@/lib/onboarding";
import { loadPairings } from "@/lib/pairing";
import { qrTokenFromFragment } from "@/lib/qr-sign-in";
import { loadPatronKey, savePatronKey } from "@/lib/sender-style";
import { useCheckoutEnabled } from "@/lib/use-patron";

const accountOrigin = import.meta.env.VITE_SERVER_URL;

interface Resource {
  id: string;
  name: string;
  billing?: {
    active: boolean;
    status: string;
    paidUntil: number | null;
    canManage: boolean;
    canSubscribe: boolean;
  };
}

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
  memberships,
  busy,
  canStyle,
  notice,
  onUse,
  onSave,
  onCheckout,
  onManage,
}: {
  plan: PatronPlan;
  memberships: readonly Resource[];
  busy: boolean;
  canStyle: boolean;
  notice?: string;
  onUse: (patronId: string) => void;
  onSave: () => void;
  onCheckout: (patronId?: string) => void;
  onManage: (patronId: string) => void;
}) => {
  const style = canStyle ? (
    <a className="pill pill-ink" href="/style" onClick={leaveForStyle}>
      Continue to Style
    </a>
  ) : null;
  // Every membership with a subscription can be managed, whatever this
  // browser holds; the plan above covers starting one.
  const billing = membershipChoices(memberships).filter(
    (membership) => membership.billing?.canManage
  );
  const active = memberships.filter(
    (membership) => membership.billing?.active ?? true
  );
  const body: Record<PatronPlan["kind"], ReactNode> = {
    here: (
      <>
        <p>You’re a patron, and your membership is on this browser.</p>
        <Actions>{style}</Actions>
      </>
    ),
    use: (
      <>
        <p>
          You’re a patron. Use your membership on this browser to send taps in a
          theme.
        </p>
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
        </Actions>
      </>
    ),
    choose: (
      <>
        <p>You’re a patron. Choose the membership to use on this browser.</p>
        {membershipChoices(active).map((membership) => (
          <div
            className="border-line flex flex-wrap items-center justify-between gap-3 border-t py-4"
            key={membership.id}
          >
            <div>
              <strong>{membership.name}</strong>
              <p className="text-tone text-sm">{membership.detail}</p>
            </div>
            <button
              className="pill"
              disabled={busy || !membership.canChoose}
              type="button"
              onClick={() => onUse(membership.id)}
            >
              Use this membership
            </button>
          </div>
        ))}
        {membershipChoices(active).some(
          (membership) => !membership.canChoose
        ) ? (
          <p>
            Some memberships cannot be distinguished here. Open billing to
            review them, or contact support before choosing.
          </p>
        ) : null}
      </>
    ),
    kept: (
      <>
        <p>
          You’re a patron, but this browser holds a different membership. It
          stays on this browser.
        </p>
        <Actions>
          {plan.kind === "kept" && !plan.saved ? (
            <button
              className="pill"
              disabled={busy}
              onClick={onSave}
              type="button"
            >
              Save membership to my account
            </button>
          ) : null}
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
            Save membership to my account
          </button>
          {style}
        </Actions>
      </>
    ),
    checkout: (
      <>
        <p>
          You’re not a patron yet. Patrons can send their taps in a theme, to
          everyone they tap. $2/month, billed $24 annually.
        </p>
        <Actions>
          <button
            className="pill pill-ink"
            disabled={busy}
            onClick={() => {
              onCheckout(plan.kind === "checkout" ? plan.patronId : undefined);
            }}
            type="button"
          >
            Become a patron
          </button>
        </Actions>
      </>
    ),
    lapsed: (
      <p>
        Your membership isn’t active. Manage billing below to restart or fix it.
      </p>
    ),
    soon: <p>You’re not a patron yet. Patron memberships open soon.</p>,
  };
  return (
    <DocSection title="Patron">
      {body[plan.kind]}
      {billing.length ? (
        <div className="flex flex-col">
          <h3 className="text-tone text-sm font-bold">Billing</h3>
          {billing.map((membership) => (
            <div
              className="border-line flex flex-wrap items-center justify-between gap-3 border-b py-4"
              key={membership.id}
            >
              <div>
                <strong>{membership.name}</strong>
                <p className="text-tone text-sm">{membership.detail}</p>
              </div>
              <button
                className="pill"
                disabled={busy}
                onClick={() => {
                  onManage(membership.id);
                }}
                type="button"
              >
                Manage billing
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <Notice>{notice}</Notice>
    </DocSection>
  );
};

/** Name and color, as the people you connect with from now on see them. */
const ProfileSection = ({
  me,
  onSaved,
  onSignedOut,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  onSignedOut: () => void;
}) => {
  const [name, setName] = useState(me.profile?.name ?? "");
  const [color, setColor] = useState<PersonColor>(
    me.profile?.color ?? "cobalt"
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const changed =
    name.trim() !== (me.profile?.name ?? "") || color !== me.profile?.color;
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      onSaved(await account.setProfile({ name: name.trim(), color }));
      setNotice(
        "Saved. People you connect with from now on see this. To change how one person sees you, use Change under your taps to them."
      );
    } catch (error) {
      if (isSignedOutError(error)) {
        onSignedOut();
        return;
      }
      setNotice(failureMessage(error));
    }
    setBusy(false);
  };
  return (
    <DocSection title="You">
      <form className="flex max-w-md flex-col gap-6" onSubmit={onSubmit}>
        <ProfileFields
          color={color}
          name={name}
          onColor={setColor}
          onName={setName}
        />
        <Notice>{notice}</Notice>
        <Actions>
          <button
            className="pill pill-ink"
            disabled={busy || !name.trim() || !changed}
            type="submit"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </Actions>
      </form>
    </DocSection>
  );
};

const SessionSection = ({ onSignedOut }: { onSignedOut: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const signOut = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      await account.signOut();
      onSignedOut();
    } catch (error) {
      setNotice(failureMessage(error));
      setBusy(false);
    }
  };
  return (
    <DocSection title="On this browser">
      <p>
        Signing out keeps the people you can tap on this browser. Sign in again
        to pick up anyone new.
      </p>
      <Actions>
        <Link className="pill pill-ink" to="/tap">
          Continue to my taps
        </Link>
        <button
          className="pill"
          disabled={busy}
          onClick={signOut}
          type="button"
        >
          Sign out
        </button>
      </Actions>
      <Notice>{notice}</Notice>
    </DocSection>
  );
};

const DeleteSection = ({ onDeleted }: { onDeleted: () => void }) => {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      await account.deleteAccount();
      onDeleted();
    } catch (error) {
      setNotice(failureMessage(error));
      setBusy(false);
    }
  };
  return (
    <DocSection title="Delete account">
      <p>
        Deletes your account and signs you out everywhere. Devices that can
        already tap someone keep working until you unpair them. An active patron
        subscription has to end first.
      </p>
      <label className="flex min-h-11 items-center gap-3 font-semibold">
        <input
          checked={confirmed}
          className="accent-ink size-5"
          onChange={(event) => {
            setConfirmed(event.target.checked);
          }}
          type="checkbox"
        />
        Delete my account
      </label>
      <Actions>
        <button
          className="pill text-destructive"
          disabled={busy || !confirmed}
          onClick={remove}
          type="button"
        >
          {busy ? "Deleting…" : "Delete account"}
        </button>
      </Actions>
      <Notice>{notice}</Notice>
    </DocSection>
  );
};

/** The account's patron memberships, with their billing facts. */
const loadMemberships = async (): Promise<Resource[]> => {
  const saved = await fetch(`${accountOrigin}/account/data`, {
    credentials: "include",
  });
  if (!saved.ok) {
    throw new Error(String(saved.status));
  }
  const data = (await saved.json()) as { patrons: Resource[] };
  let billing: {
    memberships: {
      id: string;
      status: { patron: NonNullable<Resource["billing"]> };
    }[];
  } | null = null;
  if (data.patrons.length) {
    try {
      billing = await account.patronStatus();
    } catch {
      /* Without billing facts, choices stay disabled and billing hidden. */
    }
  }
  return data.patrons.map((item) => ({
    ...item,
    billing: billing?.memberships.find(
      (membership) => membership.id === item.id
    )?.status.patron,
  }));
};

const SignedIn = ({
  me,
  intent,
  onMe,
  onSignedOut,
}: {
  me: Me;
  intent: "patron" | null;
  onMe: (me: Me) => void;
  onSignedOut: () => void;
}) => {
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [patrons, setPatrons] = useState<Resource[]>([]);
  const checkoutEnabled = useCheckoutEnabled() ?? false;
  // The patron key changes under React's feet (using a membership writes it).
  const [, setLocalVersion] = useState(0);
  const refresh = useCallback(async () => {
    try {
      setPatrons(await loadMemberships());
    } catch {
      setNotice("Patron status couldn’t load. Refresh to try again.");
    }
  }, []);
  useEffect(() => {
    // The account snapshot is an external system boundary.
    // oxlint-disable-next-line react/set-state-in-effect -- state changes happen after network requests
    refresh();
  }, [refresh]);

  const pairings = loadPairings();
  const patronKey = loadPatronKey(localStorage);
  const localPatronId = parsePatronKey(patronKey ?? "")?.patronId ?? null;
  const plan = patronPlan({
    localPatronId,
    memberships: patrons.map((p) => ({
      id: p.id,
      active: p.billing?.active ?? true,
      canSubscribe: p.billing?.canSubscribe ?? false,
    })),
    checkoutEnabled,
  });

  /** Adds one of the account's memberships to this browser. */
  const addMembership = async (patronId: string) => {
    // Never replace a membership this browser already has.
    if (patronKey) {
      setNotice(
        localPatronId === patronId
          ? "Your membership is already on this browser."
          : "This browser already has another membership. It stays."
      );
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await fetch(`${accountOrigin}/account/restore`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "patron",
          id: patronId,
          deviceName: "Web browser",
        }),
      });
      if (response.status === 401) {
        onSignedOut();
        return;
      }
      const grant = response.ok
        ? ((await response.json()) as { key?: string })
        : null;
      if (grant?.key) {
        savePatronKey(localStorage, grant.key);
        setLocalVersion((n) => n + 1);
        setNotice("Your membership is on this browser.");
      } else {
        setNotice("That couldn’t be added to this browser. Try again.");
      }
    } catch {
      setNotice("Couldn’t reach Shouldertap. Try again.");
    }
    setBusy(false);
  };

  /** Leaves for Creem: checkout or the billing portal. */
  const openBilling = async (billing: () => Promise<{ url: string }>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const link = await billing();
      const url = new URL(link.url);
      if (url.protocol === "https:") {
        forgetIntent(localStorage);
        window.location.assign(url.href);
        return;
      }
      setNotice("Billing is unavailable. Try again later.");
      setBusy(false);
    } catch (error) {
      // Billing answers 409 for its own conflicts (checkout still
      // processing, a membership already active); only 401 means signed out.
      if (error instanceof ApiError && error.code === "unauthorized") {
        onSignedOut();
        return;
      }
      setNotice(failureMessage(error));
      setBusy(false);
    }
  };

  /** Saves this browser's membership to the account, then maybe checkout. */
  const saveMembership = async (continueToCheckout = false) => {
    setBusy(true);
    setNotice(undefined);
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
      if (response.status === 401) {
        onSignedOut();
        return;
      }
      if (!response.ok) {
        setNotice("Your membership couldn’t be saved. Try again.");
        setBusy(false);
        return;
      }
      if (continueToCheckout) {
        await openBilling(() => account.patronCheckout());
        return;
      }
      await refresh();
      setNotice("Saved to your account.");
    } catch {
      setNotice("Couldn’t reach Shouldertap. Try again.");
    }
    setBusy(false);
  };

  const patronSection = (
    <PatronPanel
      busy={busy}
      canStyle={pairings.length > 0}
      key="patron"
      memberships={patrons}
      notice={notice}
      onCheckout={(patronId) =>
        patronId
          ? openBilling(() => account.patronCheckout(patronId))
          : saveMembership(true)
      }
      onManage={(patronId) => openBilling(() => account.managePatron(patronId))}
      onSave={() => saveMembership()}
      onUse={addMembership}
      plan={plan}
    />
  );
  const profileSection = (
    <ProfileSection
      key="profile"
      me={me}
      onSaved={onMe}
      onSignedOut={onSignedOut}
    />
  );
  return (
    <DocPage
      intro={`Signed in as ${me.email}`}
      title={intent === "patron" ? "Patron." : "Your account."}
    >
      {intent === "patron"
        ? [patronSection, profileSection]
        : [profileSection, patronSection]}
      <SignInOnPhone onSignedOut={onSignedOut} />
      <SessionSection onSignedOut={onSignedOut} />
      <DeleteSection
        onDeleted={() => {
          navigate({ to: "/", replace: true });
        }}
      />
    </DocPage>
  );
};

const Account = () => {
  const { intent, handoffFailed } = Route.useLoaderData();
  const [session, setSession] = useState<Session | "loading">("loading");
  const [color, setColor] = useState<PersonColor>("cobalt");
  const [confirmAccount, setConfirmAccount] = useState(handoffFailed);
  const refresh = useCallback(async () => {
    setSession("loading");
    setSession(await loadSession());
  }, []);
  useEffect(() => {
    // A session read is an external system boundary.
    // oxlint-disable-next-line react/set-state-in-effect -- state changes happen after network requests
    refresh();
  }, [refresh]);
  const signedOut = () => {
    setSession({ kind: "signed-out" });
  };

  if (session === "loading") {
    return (
      <DocPage title="Your account.">
        <output className="text-tone block py-8">Checking your sign-in…</output>
      </DocPage>
    );
  }
  if (confirmAccount && session.kind === "signed-in") {
    return (
      <DocPage title="Your account.">
        <DocSection title="That sign-in from the app expired">
          <p>
            This browser is signed in as {session.me.email}. Continue with that
            account, or sign out and sign in again.
          </p>
          <Actions>
            <button
              className="pill pill-ink"
              onClick={() => {
                setConfirmAccount(false);
              }}
              type="button"
            >
              Continue as {session.me.email}
            </button>
            <button
              className="pill"
              onClick={async () => {
                setConfirmAccount(false);
                await account.signOut().catch(() => null);
                signedOut();
              }}
              type="button"
            >
              Sign out
            </button>
          </Actions>
        </DocSection>
      </DocPage>
    );
  }
  if (session.kind === "offline") {
    return (
      <DocPage title="Your account.">
        <DocSection title="Couldn’t reach your account">
          <p>Check your connection and try again.</p>
          <Actions>
            <button className="pill" onClick={refresh} type="button">
              Try again
            </button>
          </Actions>
        </DocSection>
      </DocPage>
    );
  }
  if (session.kind === "signed-out" || !session.me.profile) {
    return (
      <Frame color={color}>
        <Mark className="size-9" />
        <SignIn
          color={color}
          key={session.kind}
          lead={
            intent === "patron"
              ? "Sign in to become a patron, or to use your membership on this browser. We'll email you a six-digit code."
              : "Sign in to tap your people from this browser. We'll email you a six-digit code. No password."
          }
          me={session.kind === "signed-in" ? session.me : null}
          onColor={setColor}
          onDone={(me) => {
            setSession({ kind: "signed-in", me });
          }}
        />
      </Frame>
    );
  }
  return (
    <SignedIn
      intent={intent}
      me={session.me}
      onMe={(me) => {
        setSession({ kind: "signed-in", me });
      }}
      onSignedOut={signedOut}
    />
  );
};

export const Route = createFileRoute("/account")({
  component: Account,
  // Read once per visit: the query, or an intent remembered before sign-in.
  // The Shouldertap app opens this page with a one-time sign-in code in the
  // fragment (`#<token>`), so this browser starts signed in to the same account.
  loader: async () => {
    const handoff = qrTokenFromFragment(window.location.hash);
    let handoffFailed = false;
    if (handoff) {
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
      try {
        await account.redeemQrSignIn(handoff, "web");
      } catch {
        // Used or expired. Never fall through to whoever this browser was
        // signed in as before: the page asks first.
        handoffFailed = true;
      }
    }
    return {
      intent: resolveIntent(localStorage, window.location.search, Date.now()),
      handoffFailed,
    };
  },
});
