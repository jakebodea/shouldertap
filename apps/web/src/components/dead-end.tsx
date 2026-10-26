import { SUPPORT_EMAIL } from "@/components/document";
import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";
import { StepHeading } from "@/components/sign-in";

/** A mistyped or retired address: say so, and lead somewhere that works. */
export const NotFound = () => (
  <Frame color="graphite">
    <Mark className="size-9" />
    <StepHeading title="There's nothing here">
      This link may be mistyped or out of date. If someone sent it to invite
      you, ask them for a new one.
    </StepHeading>
    <div className="mt-auto flex flex-col gap-3">
      <a className="pill pill-ink w-full" href="/">
        Go to Shouldertap
      </a>
      <a className="pill w-full" href="/join">
        I have an invite link
      </a>
    </div>
  </Frame>
);

/** Anything a page throws lands here instead of a blank screen. */
export const PageError = () => (
  <Frame color="graphite">
    <Mark className="size-9" />
    <StepHeading title="Something went wrong">
      Try again. If it keeps happening, email {SUPPORT_EMAIL}.
    </StepHeading>
    <div className="mt-auto flex flex-col gap-3">
      <button
        className="pill pill-ink w-full"
        onClick={() => {
          window.location.reload();
        }}
        type="button"
      >
        Try again
      </button>
      <a className="pill w-full" href="/">
        Go to Shouldertap
      </a>
    </div>
  </Frame>
);
