import { QrCodeIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ApiError } from "@shouldertap/client";
import { MAX_NAME_LENGTH, personColors, swatches } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { Frame } from "@/components/frame";
import { HomeScreenCard } from "@/components/home-screen";
import { Mark } from "@/components/mark";
import { QrScanner } from "@/components/qr-scanner";
import { api, revokePairing } from "@/lib/api";
import { frameStyle } from "@/lib/frame";
import { isIosBrowser } from "@/lib/install";
import {
  addPairing,
  loadPairings,
  pairingForCode,
  selectPairing,
} from "@/lib/pairing";

// The invite code travels in the URL fragment so it never reaches a server log.
const LEADING_HASH = /^#/u;
const readCode = () =>
  decodeURIComponent(window.location.hash.replace(LEADING_HASH, "")).trim();

/** A pasted invite: the full link (code after "#") or just the code. */
const codeFromPaste = (value: string) => {
  const trimmed = value.trim();
  const hash = trimmed.indexOf("#");
  return decodeURIComponent(hash === -1 ? trimmed : trimmed.slice(hash + 1));
};

/** The code from a scanned invite link, or null for any other QR code. */
const codeFromScan = (value: string) => {
  try {
    const url = new URL(value);
    return url.pathname === "/join" && url.hash.length > 1
      ? codeFromPaste(value)
      : null;
  } catch {
    return null;
  }
};

const JoinComponent = () => {
  const navigate = useNavigate();
  const [code, setCode] = useState(readCode);
  const [pairInBrowser, setPairInBrowser] = useState(() => !isIosBrowser());
  const [name, setName] = useState("");
  const [color, setColor] = useState<PersonColor>("cobalt");
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Resolves to the message to show, or null once the pairing succeeded.
  const redeem = async (): Promise<string | null> => {
    try {
      const grant = await api.redeemInvite({ code, name: name.trim(), color });
      if (grant.kind !== "sender") {
        return "That code is for pairing another Mac. Enter it in the Shouldertap Mac app.";
      }
      const replaced = addPairing({
        token: grant.token,
        credentialId: grant.credentialId,
        senderName: name.trim(),
        recipientName: grant.recipientName,
        color,
      });
      for (const old of replaced) {
        revokePairing(old);
      }
      history.replaceState(null, "", "/join");
      navigate({ to: "/tap" });
      return null;
    } catch (error) {
      return error instanceof ApiError && error.code !== "network"
        ? error.message
        : "Couldn't reach Shouldertap. Check your connection and try again.";
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setSubmitError(null);
    const failure = await redeem();
    if (failure !== null) {
      setSubmitError(failure);
    }
    setPending(false);
  };

  if (!code) {
    return (
      <PasteInvite
        onCode={(pasted) => {
          const paired = pairingForCode(pasted);
          if (paired) {
            selectPairing(paired.credentialId);
            toast(`This phone already taps ${paired.recipientName}`);
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
    <Frame color={color}>
      <Mark className="size-9" />
      <div className="flex flex-col gap-2">
        <h1 className="text-[2.125rem] leading-none font-extrabold tracking-[-0.035em] text-balance">
          You&apos;re invited
        </h1>
        <p className="text-tone text-[1.0625rem] leading-snug">
          Pair this phone to send taps. They cover the other person&apos;s Mac
          screens until they answer.
        </p>
      </div>

      {pairInBrowser ? null : (
        <HomeScreenCard
          onSkip={() => {
            setPairInBrowser(true);
          }}
        />
      )}

      <form
        className="flex flex-1 flex-col gap-6"
        hidden={!pairInBrowser}
        onSubmit={onSubmit}
      >
        <div>
          <label className="mb-2 block text-sm font-bold" htmlFor="sender-name">
            Your name
          </label>
          <input
            // oxlint-disable-next-line jsx-a11y/autocomplete-valid -- given-name is a valid HTML autocomplete token that oxlint's list omits; "name" would change what iOS autofills
            autoComplete="given-name"
            className="field"
            id="sender-name"
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="e.g. Sam"
            value={name}
          />
        </div>

        <fieldset>
          <legend className="mb-2 block text-sm font-bold">Your color</legend>
          <div className="grid max-w-[24rem] grid-cols-8 gap-2">
            {personColors.map((option) => (
              <label
                className="has-[:focus-visible]:outline-ink relative grid aspect-square w-full cursor-pointer place-items-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)] has-[:checked]:shadow-[0_0_0_2px_var(--paper),0_0_0_4px_var(--ink)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4"
                key={option}
                style={{
                  background: swatches[option].base,
                  color: swatches[option].ink,
                }}
              >
                <input
                  aria-label={swatches[option].label}
                  checked={color === option}
                  className="peer sr-only"
                  name="color"
                  onChange={() => {
                    setColor(option);
                  }}
                  type="radio"
                  value={option}
                />
                <HugeiconsIcon
                  className="size-5 opacity-0 transition-opacity peer-checked:opacity-100"
                  icon={Tick02Icon}
                  strokeWidth={2}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <figure className="flex flex-col gap-2">
          <TapPreview color={color} name={name.trim() || "You"} />
          <figcaption className="text-tone text-[0.8125rem]">
            How your taps look on their Mac
          </figcaption>
        </figure>

        <div className="mt-auto flex flex-col gap-3">
          {submitError ? (
            <p className="text-destructive text-[0.9375rem]">{submitError}</p>
          ) : null}
          <button
            className="pill pill-frame w-full"
            disabled={pending || !name.trim()}
            type="submit"
          >
            {pending ? "Pairing…" : "Pair this phone"}
          </button>
          <p className="text-tone text-center text-[0.8125rem]">
            By pairing, you agree to the{" "}
            <a
              className="text-ink underline underline-offset-[3px]"
              href="/terms"
            >
              Terms
            </a>{" "}
            and{" "}
            <a
              className="text-ink underline underline-offset-[3px]"
              href="/privacy"
            >
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </form>
    </Frame>
  );
};

/**
 * Reached without a code: a Home Screen app whose saved page lost it, a
 * phone whose pairing Safari forgot, or a paired phone adding someone. An
 * invite link opens in Safari, not in the Home Screen app, so adding someone
 * there means scanning or pasting it.
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
      <div className="flex flex-col gap-2">
        <h1 className="text-[2.125rem] leading-none font-extrabold tracking-[-0.035em]">
          {adding ? "Add someone" : "Pair this phone"}
        </h1>
        <p className="text-tone text-[1.0625rem] leading-snug">
          {adding
            ? "Scan the invite QR code on their Mac, or paste the invite link they sent you."
            : "Scan the invite QR code on their Mac, or paste the invite link you were sent. If this phone used to send taps and stopped, Safari may have forgotten the pairing: ask for a new invite."}
        </p>
      </div>
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
      {adding ? (
        <Link
          className="text-tone self-center text-[0.9375rem] underline underline-offset-[3px]"
          replace
          to="/tap"
        >
          Cancel
        </Link>
      ) : null}
    </Frame>
  );
};

/** A miniature of the Mac overlay, framed in the chosen color. */
const TapPreview = ({ color, name }: { color: PersonColor; name: string }) => (
  <div
    aria-hidden="true"
    className="bg-frame text-frame-ink relative rounded-2xl px-2 pt-[1.6rem] pb-2 transition-colors duration-500"
    style={frameStyle(color)}
  >
    <div className="absolute top-[0.4rem] left-3.5 flex gap-1.5 text-[0.6875rem]">
      <span className="max-w-40 truncate font-bold">{name}</span>
      <span className="opacity-75">just now</span>
    </div>
    <div className="bg-paper text-ink rounded-[0.625rem] px-4 pt-[1.125rem] pb-3.5">
      <p className="mb-3 text-2xl leading-none font-extrabold tracking-[-0.035em]">
        Can you come here?
      </p>
      <div className="flex gap-1.5">
        <i className="bg-frame h-4 w-10 rounded-full" />
        <i className="h-4 w-10 rounded-full shadow-[inset_0_0_0_1px_var(--line)]" />
        <i className="h-4 w-10 rounded-full shadow-[inset_0_0_0_1px_var(--line)]" />
      </div>
    </div>
  </div>
);

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
