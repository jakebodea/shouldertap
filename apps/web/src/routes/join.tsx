import { QrCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvitePreview, Me, Profile } from "@shouldertap/client";
import { fallbackColor } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";
import { MiniTap } from "@/components/mini-tap";
import { QrScanner } from "@/components/qr-scanner";
import { ChooseSeenAs, useSendDefault } from "@/components/seen-as";
import { SignIn, StepHeading } from "@/components/sign-in";
import {
  account,
  loadSession,
  needsSignIn,
  syncThisBrowser,
  thisDevice,
} from "@/lib/account";
import { revokePairing } from "@/lib/api";
import { IPHONE_APP_LIVE, IPHONE_APP_URL } from "@/lib/download";
import {
  codeFromPaste,
  codeFromScan,
  failureMessage,
  inviteFailure,
  inviteLink,
  isIPhoneBrowser,
  OFFLINE_MESSAGE,
} from "@/lib/onboarding";
import {
  addPairing,
  inboxOf,
  loadPairings,
  pairingForCode,
  pairingFromSender,
  selectPairing,
} from "@/lib/pairing";

// The invite code travels in the URL fragment so it never reaches a server log.
const readCode = () => codeFromPaste(window.location.hash.slice(1));

const JoinComponent = () => {
  const navigate = useNavigate();
  const [code, setCode] = useState(readCode);
  // Another invite link pasted into the address bar only changes the hash.
  useEffect(() => {
    const onHashChange = () => setCode(readCode());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  if (!code) {
    return (
      <PasteInvite
        onCode={(pasted) => {
          const paired = pairingForCode(pasted);
          if (paired) {
            selectPairing(paired.credentialId);
            toast(`You can already tap ${paired.recipientName}`);
            navigate({ to: "/tap", replace: true });
            return;
          }
          history.replaceState(null, "", `/join#${encodeURIComponent(pasted)}`);
          setCode(pasted);
        }}
      />
    );
  }
  return (
    <Invite
      code={code}
      key={code}
      onReset={() => {
        history.replaceState(null, "", "/join");
        setCode("");
      }}
    />
  );
};

type Phase =
  | { readonly kind: "invite" }
  /** Signed out, or signed in without a profile: sign in right here. */
  | { readonly kind: "sign-in"; readonly me: Me | null }
  | {
      readonly kind: "connected";
      readonly name: string;
      readonly mutual: boolean;
    };

type Lookup =
  | { readonly kind: "loading" }
  | { readonly kind: "found"; readonly invite: InvitePreview }
  | {
      readonly kind: "failed";
      readonly failure: ReturnType<typeof inviteFailure>;
    };

/**
 * "{name} invited you to Shouldertap": who it's from, in their color, and
 * Accept. Accepting signs in first if needed, then connects you both ways.
 */
const Invite = ({ code, onReset }: { code: string; onReset: () => void }) => {
  const navigate = useNavigate();
  const [lookup, setLookup] = useState<Lookup>({ kind: "loading" });
  const [phase, setPhase] = useState<Phase>({ kind: "invite" });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [ownColor, setOwnColor] = useState<PersonColor | null>(null);
  const sendDefault = useSendDefault();
  /** Chosen for just this person on the invite screen. */
  const [seenAs, setSeenAs] = useState<Profile | null>(null);

  const load = useCallback(async () => {
    setLookup({ kind: "loading" });
    try {
      setLookup({ kind: "found", invite: await account.previewInvite(code) });
    } catch (error) {
      setLookup({ kind: "failed", failure: inviteFailure(error) });
    }
  }, [code]);
  useEffect(() => {
    // The invite lookup is a request to the API, an external system.
    // oxlint-disable-next-line react/set-state-in-effect -- state changes after the request
    load();
  }, [load]);

  const invite = lookup.kind === "found" ? lookup.invite : null;
  // Reaching this page on an iPhone means the app isn't installed yet.
  const onIPhone = useMemo(
    () => IPHONE_APP_LIVE && isIPhoneBrowser(navigator.userAgent),
    []
  );
  const theirColor = invite?.color ?? fallbackColor(inboxOf(code) ?? code);
  // A first color for the You step that isn't the inviter's own.
  const suggestedColor: PersonColor =
    theirColor === "cobalt" ? "moss" : "cobalt";

  const finish = async () => {
    setPending(true);
    setFailure(null);
    try {
      const result = await account.accept({
        code,
        platform: "web",
        deviceName: thisDevice(),
        ...(seenAs ? { profile: seenAs } : {}),
      });
      if (result.sender) {
        const replaced = addPairing(
          pairingFromSender(result.sender, result.person.name)
        );
        for (const old of replaced) {
          revokePairing(old);
        }
      } else {
        // Already connected: this browser may still need its own key.
        await syncThisBrowser().catch(() => null);
        const paired = pairingForCode(code);
        if (paired) {
          selectPairing(paired.credentialId);
        }
      }
      history.replaceState(null, "", "/join");
      setPhase({
        kind: "connected",
        name: result.person.name,
        mutual: result.mutual,
      });
    } catch (error) {
      setFailure(failureMessage(error));
      setPhase({ kind: "invite" });
    }
    setPending(false);
  };

  const accept = async () => {
    setPending(true);
    setFailure(null);
    const session = await loadSession();
    if (session.kind === "offline") {
      setFailure(OFFLINE_MESSAGE);
      setPending(false);
      return;
    }
    if (needsSignIn(session)) {
      setPending(false);
      setPhase({
        kind: "sign-in",
        me: session.kind === "signed-in" ? session.me : null,
      });
      return;
    }
    await finish();
  };

  if (phase.kind === "connected") {
    return (
      <Frame color={theirColor}>
        <Mark className="size-9" />
        <StepHeading title={`You and ${phase.name} are connected`}>
          {phase.mutual
            ? "You can tap each other now. Taps cover their screen until they answer."
            : `You can tap ${phase.name} now. Taps cover their screen until they answer.`}
        </StepHeading>
        <MiniTap color={theirColor} name={phase.name} />
        <button
          className="pill pill-frame mt-auto w-full"
          onClick={() => {
            navigate({ to: "/tap", replace: true });
          }}
          type="button"
        >
          Tap {phase.name}
        </button>
      </Frame>
    );
  }

  if (phase.kind === "sign-in") {
    const color = ownColor ?? suggestedColor;
    return (
      <Frame color={ownColor ?? theirColor}>
        <Mark className="size-9" />
        <SignIn
          color={color}
          lead={
            invite
              ? `Sign in to accept ${invite.name}'s invite. We'll email you a six-digit code. No password.`
              : undefined
          }
          me={phase.me}
          onColor={setOwnColor}
          onDone={finish}
        />
        {pending ? (
          <output className="text-tone block text-center">Connecting…</output>
        ) : null}
        {failure ? (
          <p className="text-destructive text-[0.9375rem]" role="alert">
            {failure}
          </p>
        ) : null}
      </Frame>
    );
  }

  if (lookup.kind === "failed") {
    return (
      <Frame color="graphite">
        <Mark className="size-9" />
        <StepHeading title={lookup.failure.title}>
          {lookup.failure.message}
        </StepHeading>
        <div className="mt-auto flex flex-col gap-3">
          {lookup.failure.retry ? (
            <button className="pill w-full" onClick={load} type="button">
              Try again
            </button>
          ) : null}
          <button className="pill w-full" onClick={onReset} type="button">
            Use another link
          </button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame color={theirColor}>
      <Mark className="size-9" />
      {invite ? (
        <>
          <StepHeading title={`${invite.name} invited you to Shouldertap`}>
            Accept to tap each other. A tap covers their screen until they
            answer.
          </StepHeading>
          <figure className="flex flex-col gap-2">
            <MiniTap color={theirColor} name={invite.name} />
            <figcaption className="text-tone text-[0.8125rem]">
              A tap from {invite.name}
            </figcaption>
          </figure>
          <div className="mt-auto flex flex-col gap-3">
            {sendDefault ? (
              <ChooseSeenAs
                initial={sendDefault}
                onChange={setSeenAs}
                person={invite.name}
                value={seenAs}
              />
            ) : null}
            {failure ? (
              <p className="text-destructive text-[0.9375rem]" role="alert">
                {failure}
              </p>
            ) : null}
            {onIPhone ? (
              <GetTheApp code={code} name={invite.name} onSafari={accept} />
            ) : (
              <button
                className="pill pill-frame w-full"
                disabled={pending}
                onClick={accept}
                type="button"
              >
                {pending ? "Accepting…" : "Accept"}
              </button>
            )}
          </div>
        </>
      ) : (
        <output className="text-tone block py-8">Opening your invite…</output>
      )}
    </Frame>
  );
};

/**
 * An invite opened on an iPhone without the app: get it from the App Store.
 * The link is copied on the way, so the app can pick the invite up on its
 * first screen; opening the link again once it's installed works too.
 */
const GetTheApp = ({
  code,
  name,
  onSafari,
}: {
  code: string;
  name: string;
  onSafari: () => void;
}) => {
  const getApp = async () => {
    try {
      await navigator.clipboard.writeText(
        inviteLink(window.location.origin, code)
      );
    } catch {
      // Without the clipboard, opening the link again still works.
    }
    window.location.href = IPHONE_APP_URL;
  };
  return (
    <>
      <p className="text-tone text-[0.9375rem]">
        Get Shouldertap for iPhone, then open it and tap Paste to accept {name}
        &apos;s invite. Or come back and open this link again.
      </p>
      <button className="pill pill-frame w-full" onClick={getApp} type="button">
        Get Shouldertap on the App Store
      </button>
      <button
        className="text-tone self-center text-[0.9375rem] underline underline-offset-[3px]"
        onClick={onSafari}
        type="button"
      >
        Accept in Safari instead
      </button>
    </>
  );
};

/**
 * Reached without a code: a Home Screen app whose saved page lost it, or a
 * signed-in browser adding someone. An invite link opens in Safari, not in
 * the Home Screen app, so adding someone there means scanning or pasting it.
 */
const PasteInvite = ({ onCode }: { onCode: (code: string) => void }) => {
  const adding = useMemo(() => loadPairings().length > 0, []);
  const [value, setValue] = useState("");
  const [scanning, setScanning] = useState(false);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const pasted = codeFromPaste(value);
    if (pasted) {
      onCode(pasted);
    }
  };
  const onScan = (scanned: string) => {
    const code = codeFromScan(scanned);
    if (code) {
      onCode(code);
    }
    return code !== null;
  };
  return (
    <Frame color="graphite">
      <Mark className="size-9" />
      <StepHeading title={adding ? "Add someone" : "Got a link?"}>
        Scan their invite QR code, or paste the invite link they sent you.
      </StepHeading>
      {scanning ? (
        <div className="flex flex-col gap-3">
          <QrScanner onScan={onScan} />
          <button
            className="pill w-full"
            onClick={() => {
              setScanning(false);
            }}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="pill pill-ink w-full"
          onClick={() => {
            setScanning(true);
          }}
          type="button"
        >
          <HugeiconsIcon
            aria-hidden="true"
            className="size-5"
            icon={QrCodeIcon}
            strokeWidth={2}
          />
          Scan QR code
        </button>
      )}
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="invite-link">
          Invite link
        </label>
        <input
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="field"
          id="invite-link"
          onChange={(event) => {
            setValue(event.target.value);
          }}
          placeholder="https://shouldertap.app/join#…"
          spellCheck={false}
          value={value}
        />
        <button className="pill w-full" disabled={!value.trim()} type="submit">
          Continue
        </button>
      </form>
      <Link
        className="text-tone self-center text-[0.9375rem] underline underline-offset-[3px]"
        replace
        to="/tap"
      >
        {adding ? "Cancel" : "Invite someone instead"}
      </Link>
    </Frame>
  );
};

// A Home Screen app keeps launching the page it was saved from, invite code
// and all. Once that person is paired, launching it opens the composer.
export const Route = createFileRoute("/join")({
  beforeLoad: () => {
    const paired = pairingForCode(readCode());
    if (paired) {
      selectPairing(paired.credentialId);
      throw redirect({ to: "/tap", replace: true });
    }
  },
  component: JoinComponent,
});
