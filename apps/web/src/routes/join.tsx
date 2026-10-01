import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ApiError } from "@shouldertap/client";
import {
  MAX_NAME_LENGTH,
  type PersonColor,
  personColors,
  swatches,
} from "@shouldertap/domain";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { Frame } from "@/components/frame";
import { HomeScreenCard } from "@/components/home-screen";
import { Mark } from "@/components/mark";
import { api } from "@/lib/api";
import { frameStyle } from "@/lib/frame";
import { isIosBrowser } from "@/lib/install";
import { loadPairing, savePairing } from "@/lib/pairing";

export const Route = createFileRoute("/join")({
  component: JoinComponent,
});

// The invite code travels in the URL fragment so it never reaches a server log.
const LEADING_HASH = /^#/;
const readCode = () =>
  decodeURIComponent(window.location.hash.replace(LEADING_HASH, "")).trim();

/** A pasted invite: the full link (code after "#") or just the code. */
const codeFromPaste = (value: string) => {
  const trimmed = value.trim();
  const hash = trimmed.indexOf("#");
  return decodeURIComponent(hash === -1 ? trimmed : trimmed.slice(hash + 1));
};

function JoinComponent() {
  const navigate = useNavigate();
  const [code, setCode] = useState(readCode);
  const [pairInBrowser, setPairInBrowser] = useState(() => !isIosBrowser());
  const [name, setName] = useState("");
  const [color, setColor] = useState<PersonColor>("cobalt");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = loadPairing();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const grant = await api.redeemInvite({ code, name: name.trim(), color });
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
        color,
      });
      history.replaceState(null, "", "/join");
      navigate({ to: "/tap" });
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

  if (!code) {
    return (
      <PasteInvite
        onCode={(pasted) => {
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
        <h1 className="text-balance font-extrabold text-[2.125rem] leading-none tracking-[-0.035em]">
          You're invited
        </h1>
        <p className="text-[1.0625rem] text-tone leading-snug">
          Pair this phone to send taps. They cover the other person's Mac
          screens until they answer.
        </p>
      </div>

      {pairInBrowser ? null : (
        <HomeScreenCard onSkip={() => setPairInBrowser(true)} />
      )}

      {existing ? (
        <p className="rounded-2xl bg-faint px-4 py-3 text-[0.9375rem] leading-snug">
          This phone already sends taps to {existing.recipientName}. Pairing
          again replaces that.
        </p>
      ) : null}

      <form
        className="flex flex-1 flex-col gap-6"
        hidden={!pairInBrowser}
        onSubmit={onSubmit}
      >
        <div>
          <label className="mb-2 block font-bold text-sm" htmlFor="sender-name">
            Your name
          </label>
          <input
            autoComplete="given-name"
            className="field"
            id="sender-name"
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Sam"
            value={name}
          />
        </div>

        <fieldset>
          <legend className="mb-2 block font-bold text-sm">Your color</legend>
          <div className="grid max-w-[24rem] grid-cols-8 gap-2">
            {personColors.map((option) => (
              <label
                className="relative grid aspect-square w-full cursor-pointer place-items-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)] has-[:checked]:shadow-[0_0_0_2px_var(--paper),0_0_0_4px_var(--ink)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink has-[:focus-visible]:outline-offset-4"
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
                  onChange={() => setColor(option)}
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
          <figcaption className="text-[0.8125rem] text-tone">
            How your taps look on their Mac
          </figcaption>
        </figure>

        <div className="mt-auto flex flex-col gap-3">
          {error ? (
            <p className="text-[0.9375rem] text-destructive">{error}</p>
          ) : null}
          <button
            className="pill pill-frame w-full"
            disabled={pending || !name.trim()}
            type="submit"
          >
            {pending ? "Pairing…" : "Pair this phone"}
          </button>
          <p className="text-center text-[0.8125rem] text-tone">
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
}

/**
 * Reached without a code: a Home Screen app whose saved page lost it, or a
 * phone whose pairing Safari forgot.
 */
function PasteInvite({ onCode }: { onCode: (code: string) => void }) {
  const [value, setValue] = useState("");
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const pasted = codeFromPaste(value);
    if (pasted) {
      onCode(pasted);
    }
  };
  return (
    <Frame color="graphite">
      <Mark className="size-9" />
      <div className="flex flex-col gap-2">
        <h1 className="font-extrabold text-[2.125rem] leading-none tracking-[-0.035em]">
          Pair this phone
        </h1>
        <p className="text-[1.0625rem] text-tone leading-snug">
          Paste the invite link you were sent. If this phone used to send taps
          and stopped, Safari may have forgotten the pairing: ask for a new
          invite link.
        </p>
      </div>
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
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://shouldertap.app/join#…"
          spellCheck={false}
          value={value}
        />
        <button
          className="pill pill-ink w-full"
          disabled={!value.trim()}
          type="submit"
        >
          Continue
        </button>
      </form>
    </Frame>
  );
}

/** A miniature of the Mac overlay, framed in the chosen color. */
function TapPreview({ color, name }: { color: PersonColor; name: string }) {
  return (
    <div
      aria-hidden="true"
      className="relative rounded-2xl bg-frame px-2 pt-[1.6rem] pb-2 text-frame-ink transition-colors duration-500"
      style={frameStyle(color)}
    >
      <div className="absolute top-[0.4rem] left-3.5 flex gap-1.5 text-[0.6875rem]">
        <span className="max-w-40 truncate font-bold">{name}</span>
        <span className="opacity-75">just now</span>
      </div>
      <div className="rounded-[0.625rem] bg-paper px-4 pt-[1.125rem] pb-3.5 text-ink">
        <p className="mb-3 font-extrabold text-2xl leading-none tracking-[-0.035em]">
          Can you come here?
        </p>
        <div className="flex gap-1.5">
          <i className="h-4 w-10 rounded-full bg-frame" />
          <i className="h-4 w-10 rounded-full shadow-[inset_0_0_0_1px_var(--line)]" />
          <i className="h-4 w-10 rounded-full shadow-[inset_0_0_0_1px_var(--line)]" />
        </div>
      </div>
    </div>
  );
}
