import { SquareArrowUp02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/**
 * Safari erases a site's storage after about a week without a visit, which
 * would forget the pairing. A Home Screen web app keeps its own storage, so
 * we ask senders to add it first and pair from there; the invite code rides
 * along in the saved page's URL.
 */
export function HomeScreenCard({ onSkip }: { onSkip: () => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-faint px-4 py-4">
      <h2 className="font-bold text-[1.0625rem] leading-snug">
        Add Shouldertap to your Home Screen first
      </h2>
      <p className="text-[0.9375rem] text-tone leading-snug">
        Safari can forget this pairing if you don't open it for a week. From
        your Home Screen it stays paired.
      </p>
      <ol className="flex flex-col gap-1.5 text-[0.9375rem] leading-snug">
        <li>
          1. Tap Share{" "}
          <HugeiconsIcon
            aria-label="(the square with an arrow)"
            className="inline size-[1.1em] align-[-0.2em]"
            icon={SquareArrowUp02Icon}
            strokeWidth={2}
          />{" "}
          in Safari's toolbar.
        </li>
        <li>2. Choose Add to Home Screen, then Add.</li>
        <li>3. Open Shouldertap from your Home Screen to finish pairing.</li>
      </ol>
      <p className="text-[0.9375rem] text-tone leading-snug">
        Already tap someone from your Home Screen? Copy this page's link, open
        Shouldertap there, tap the name at the top, and choose Add someone.
      </p>
      <button
        className="self-start text-[0.9375rem] text-tone underline underline-offset-[3px]"
        onClick={onSkip}
        type="button"
      >
        Pair in Safari instead
      </button>
    </section>
  );
}
