import {
  ArrowLeft01Icon,
  FavouriteIcon,
  PaintBoardIcon,
  RepeatIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fallbackColor, TAP_THEMES } from "@shouldertap/domain";
import type { TapTheme } from "@shouldertap/domain";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Frame } from "@/components/frame";
import { TapPreview } from "@/components/tap-preview/tap-preview";
import type { PreviewTap } from "@/components/tap-preview/themes";
import { styleOffer } from "@/lib/account-flow";
import { loadPairing } from "@/lib/pairing";
import { loadDraft, loadStyle, saveStyle } from "@/lib/sender-style";
import { PATRON_THEMES, THEME_NAMES } from "@/lib/theme-names";
import { usePatron } from "@/lib/use-patron";

const SAMPLE = "Dinner's ready. Come down whenever you hit a stopping point.";
const PRICE = "$2/month, billed $24 annually";

const longDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

/**
 * The sender's tap style: how their taps look on the computers of everyone
 * they tap. Everyone can browse and replay every theme; sending one other
 * than Default needs the sender's own active patron membership, checked by
 * the server on every send. Recipients never pay to see it.
 */
const StyleComponent = () => {
  const pairing = loadPairing();
  const patron = usePatron();
  const [saved, setSaved] = useState(() => loadStyle(localStorage));
  const [selected, setSelected] = useState<TapTheme>(saved);
  const [replay, setReplay] = useState(0);
  const color =
    pairing?.color ?? fallbackColor(pairing?.credentialId ?? "default");
  // The preview's clock and date: when this page opened.
  const [openedAt, setOpenedAt] = useState(() => new Date());
  const tap = useMemo<PreviewTap>(
    () => ({
      sender: pairing?.senderName ?? "You",
      text:
        (pairing ? loadDraft(localStorage, pairing.credentialId) : "").trim() ||
        SAMPLE,
      color,
      at: openedAt,
    }),
    [pairing, color, openedAt]
  );
  if (!pairing) {
    return null;
  }

  const paid = selected !== "default";
  const canUse = !paid || patron.active;
  const offer = patronOffer(patron);
  const use = () => {
    saveStyle(localStorage, selected);
    setSaved(selected);
  };

  return (
    <Frame color={color}>
      <header className="flex items-center gap-3">
        <Link
          aria-label={`Back to tapping ${pairing.recipientName}`}
          className="pill pill-sm -ml-1 px-3"
          to="/tap"
        >
          <HugeiconsIcon className="size-5" icon={ArrowLeft01Icon} />
        </Link>
        <h1 className="text-[2.125rem] leading-none font-extrabold tracking-[-0.035em]">
          Tap style
        </h1>
      </header>
      <p className="text-tone -mt-2 text-[0.9375rem] leading-snug">
        How your taps look on the screens of everyone you tap. They never pay to
        see it.
      </p>

      <section aria-label={`${THEME_NAMES[selected].name} preview`}>
        <TapPreview
          className="w-full rounded-[14px] shadow-[0_1px_2px_rgb(0_0_0/0.06),0_14px_30px_-16px_rgb(0_0_0/0.4)]"
          replay={replay}
          tap={tap}
          theme={selected}
        />
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[1.3125rem] leading-tight font-extrabold tracking-[-0.02em]">
              {THEME_NAMES[selected].name}
            </h2>
            <p className="text-tone text-[0.9375rem] leading-snug">
              {THEME_NAMES[selected].sub}
            </p>
          </div>
          <button
            className="pill pill-sm shrink-0"
            onClick={() => {
              setOpenedAt(new Date());
              setReplay((n) => n + 1);
            }}
            type="button"
          >
            <HugeiconsIcon className="size-[18px]" icon={RepeatIcon} />
            Replay
          </button>
        </div>
      </section>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-tone mb-1 text-sm font-bold">Themes</legend>
        {TAP_THEMES.map((theme) => (
          <label
            className={`flex cursor-pointer items-center gap-3 rounded-2xl p-2 pr-3 transition-shadow ${
              selected === theme
                ? "shadow-[inset_0_0_0_2px_var(--ink)]"
                : "shadow-[inset_0_0_0_1.5px_var(--line)]"
            }`}
            key={theme}
          >
            <input
              checked={selected === theme}
              className="sr-only"
              name="theme"
              onChange={() => {
                setSelected(theme);
              }}
              type="radio"
              value={theme}
            />
            <TapPreview
              className="w-[104px] shrink-0 rounded-[7px]"
              replay={0}
              tap={tap}
              theme={theme}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[1.0625rem] leading-tight font-bold">
                {THEME_NAMES[theme].name}
              </span>
              <span className="text-tone block text-[0.875rem] leading-snug">
                {THEME_NAMES[theme].sub}
                {theme === "default" || patron.active ? "" : " · Patrons"}
                {saved === theme ? " · in use" : ""}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <UseAction
        canUse={canUse}
        inUse={saved === selected}
        name={THEME_NAMES[selected].name}
        offer={offer}
        onUse={use}
        patron={patron}
      />

      <PatronSection offer={offer} patron={patron} />
    </Frame>
  );
};

/**
 * The page's one action for the selected theme. A patron theme a sender
 * can't use yet leads to checkout instead of a disabled button.
 */
const UseAction = ({
  name,
  inUse,
  canUse,
  offer,
  patron,
  onUse,
}: {
  name: string;
  inUse: boolean;
  canUse: boolean;
  offer: ReturnType<typeof styleOffer>;
  patron: ReturnType<typeof usePatron>;
  onUse: () => void;
}) => {
  if (inUse) {
    return (
      <p className="text-tone text-center text-[0.9375rem] font-semibold">
        Your taps use {name}.
      </p>
    );
  }
  if (!canUse && offer === "subscribe") {
    return (
      <div className="flex flex-col gap-2">
        <button
          className="pill pill-frame w-full"
          disabled={patron.busy || !patron.loaded}
          onClick={() => {
            patron.subscribe();
          }}
          type="button"
        >
          Become a patron to use {name}
        </button>
        <p className="text-tone text-center text-[0.8125rem]">
          {PRICE}, plus tax. Come back here to switch it on.
        </p>
      </div>
    );
  }
  return (
    <button
      className="pill pill-frame w-full"
      disabled={!canUse}
      onClick={onUse}
      type="button"
    >
      Use {name}
    </button>
  );
};

const PERKS = [
  {
    icon: PaintBoardIcon,
    text: `${new Intl.ListFormat("en").format(PATRON_THEMES.map((theme) => THEME_NAMES[theme].name))}, on every tap you send.`,
  },
  {
    icon: UserGroupIcon,
    text: "To everyone you tap, on every device you link. They never pay to see it.",
  },
  {
    icon: FavouriteIcon,
    text: "Helps cover running costs, so sending and answering stay free for everyone.",
  },
] as const;

/** What a sender without an active membership can do about it. */
const patronOffer = (patron: ReturnType<typeof usePatron>) =>
  styleOffer({
    canManage: patron.status?.patron.canManage ?? false,
    canSubscribe: patron.status?.patron.canSubscribe ?? true,
    checkoutEnabled: patron.checkoutEnabled,
  });

/** The call to action for a sender without an active membership. */
const PatronOffer = ({
  offer,
  patron,
  onManage,
  onSubscribe,
}: {
  offer: ReturnType<typeof styleOffer>;
  patron: ReturnType<typeof usePatron>;
  onManage: () => void;
  onSubscribe: () => void;
}) => (
  <>
    {patron.status?.patron.status === "payment_issue" ? (
      <p className="text-[0.9375rem] leading-snug font-semibold">
        Your last payment didn’t go through.
      </p>
    ) : null}
    {offer === "manage" ? (
      <button
        className="pill pill-ink w-full"
        disabled={patron.busy}
        onClick={onManage}
        type="button"
      >
        Manage billing
      </button>
    ) : null}
    {offer === "subscribe" ? (
      <>
        <button
          className="pill pill-ink w-full"
          disabled={patron.busy || !patron.loaded}
          onClick={onSubscribe}
          type="button"
        >
          Become a patron
        </button>
        <p className="text-tone text-center text-[0.8125rem]">
          {PRICE}, plus tax. Renews yearly until canceled.
        </p>
      </>
    ) : null}
    {offer === "soon" ? (
      <p className="bg-faint rounded-2xl px-4 py-3 text-[0.9375rem] leading-snug font-semibold">
        Patron memberships open soon.
      </p>
    ) : null}
  </>
);

const PatronSection = ({
  patron,
  offer,
}: {
  patron: ReturnType<typeof usePatron>;
  offer: ReturnType<typeof styleOffer>;
}) => {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(
    null
  );
  const [entering, setEntering] = useState(false);
  const [entry, setEntry] = useState("");
  const membership = patron.status?.patron;
  const handleManage = () => {
    patron.manage();
  };
  const handleSubscribe = () => {
    patron.subscribe();
  };

  const redeem = async (event: FormEvent) => {
    event.preventDefault();
    if (await patron.redeem(entry)) {
      setEntering(false);
      setEntry("");
    }
  };

  return (
    <section
      aria-labelledby="patron"
      className="border-line flex flex-col gap-3 border-t pt-5"
    >
      <h2
        className="text-[1.3125rem] leading-tight font-extrabold tracking-[-0.02em]"
        id="patron"
      >
        {membership?.active ? "Patron" : "Become a patron"}
      </h2>
      {membership?.active ? (
        <>
          <p className="text-[0.9375rem] leading-snug">
            Thank you. Your taps can use any theme, to everyone you tap.{" "}
            {membership.paidUntil
              ? `${membership.status === "ending" ? "Ends" : "Renews"} ${longDate(membership.paidUntil)}.`
              : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="pill pill-sm"
              disabled={patron.busy}
              onClick={handleManage}
              type="button"
            >
              Manage billing
            </button>
            <button
              className="pill pill-sm"
              disabled={patron.busy}
              onClick={async () => {
                setCode(await patron.linkCode());
              }}
              type="button"
            >
              Add another device
            </button>
          </div>
          {code ? (
            <p className="bg-faint rounded-2xl px-4 py-3 text-[0.9375rem] leading-snug">
              On your other phone or browser, open Tap style and enter this code
              under “Have a code”. It works once, until{" "}
              {new Date(code.expiresAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
              :
              <code className="mt-2 block font-mono text-[0.8125rem] break-all select-all">
                {code.code}
              </code>
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-[2.75rem] leading-none font-extrabold tracking-[-0.045em]">
            $2<span className="text-tone text-[0.4em]">/month</span>
          </p>
          <ul className="flex flex-col gap-3">
            {PERKS.map((perk) => (
              <li className="flex items-start gap-3" key={perk.text}>
                <HugeiconsIcon
                  className="mt-px size-5 shrink-0"
                  icon={perk.icon}
                />
                <span className="text-[0.9375rem] leading-snug">
                  {perk.text}
                </span>
              </li>
            ))}
          </ul>
          <PatronOffer
            offer={offer}
            onManage={handleManage}
            onSubscribe={handleSubscribe}
            patron={patron}
          />
          <a
            className="text-ink self-center text-[0.875rem] underline underline-offset-[3px]"
            href="/account?intent=patron"
          >
            Already a patron? Restore from your account
          </a>
          {entering ? (
            <form className="flex gap-2" onSubmit={redeem}>
              <label className="sr-only" htmlFor="patron-code">
                Code from your other device
              </label>
              <input
                autoComplete="off"
                className="field min-w-0 flex-1 font-mono text-[0.875rem]"
                id="patron-code"
                onChange={(event) => {
                  setEntry(event.target.value);
                }}
                placeholder="stp1…"
                value={entry}
              />
              <button
                className="pill pill-sm"
                disabled={!entry.trim() || patron.busy}
                type="submit"
              >
                Add
              </button>
            </form>
          ) : (
            <button
              className="text-ink self-center text-[0.875rem] underline underline-offset-[3px]"
              onClick={() => {
                setEntering(true);
              }}
              type="button"
            >
              Have a code from another device?
            </button>
          )}
        </>
      )}
      {patron.error ? (
        <p
          className="text-destructive text-[0.9375rem] leading-snug font-semibold"
          role="alert"
        >
          {patron.error}
        </p>
      ) : null}
    </section>
  );
};

export const Route = createFileRoute("/style")({
  beforeLoad: () => {
    if (!loadPairing()) {
      throw redirect({ to: "/tap", replace: true });
    }
  },
  component: StyleComponent,
});
