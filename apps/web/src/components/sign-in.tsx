import type { Me } from "@shouldertap/client";
import { MAX_NAME_LENGTH } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { ColorPicker, MiniTap } from "@/components/mini-tap";
import { account } from "@/lib/account";
import {
  CODE_LENGTH,
  codeFailureMessage,
  failureMessage,
  otpDigits,
} from "@/lib/onboarding";

/** A step's title and one line under it, as on every sender page. */
export const StepHeading = ({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    <h1 className="text-[2.125rem] leading-none font-extrabold tracking-[-0.035em] text-balance">
      {title}
    </h1>
    {children ? (
      <p className="text-tone text-[1.0625rem] leading-snug">{children}</p>
    ) : null}
  </div>
);

const Failure = ({ children }: { children: string | null }) =>
  children ? (
    <p className="text-destructive text-[0.9375rem]" role="alert">
      {children}
    </p>
  ) : null;

const Terms = () => (
  <p className="text-tone text-center text-[0.8125rem]">
    By continuing, you agree to the{" "}
    <a className="text-ink underline underline-offset-[3px]" href="/terms">
      Terms
    </a>{" "}
    and{" "}
    <a className="text-ink underline underline-offset-[3px]" href="/privacy">
      Privacy Policy
    </a>
    .
  </p>
);

/** Name, color, and how a tap from them looks. */
export const ProfileFields = ({
  name,
  color,
  onName,
  onColor,
}: {
  name: string;
  color: PersonColor;
  onName: (name: string) => void;
  onColor: (color: PersonColor) => void;
}) => (
  <>
    <div>
      <label className="mb-2 block text-sm font-bold" htmlFor="profile-name">
        Your name
      </label>
      <input
        // oxlint-disable-next-line jsx-a11y/autocomplete-valid -- given-name is a valid HTML autocomplete token that oxlint's list omits; "name" would change what iOS autofills
        autoComplete="given-name"
        className="field"
        id="profile-name"
        maxLength={MAX_NAME_LENGTH}
        onChange={(event) => {
          onName(event.target.value);
        }}
        placeholder="e.g. Sam"
        value={name}
      />
    </div>
    <ColorPicker onChange={onColor} value={color} />
    <figure className="flex flex-col gap-2">
      <MiniTap color={color} name={name.trim() || "You"} />
      <figcaption className="text-tone text-[0.8125rem]">
        How your taps look
      </figcaption>
    </figure>
  </>
);

const EmailStep = ({
  initialEmail,
  title,
  lead,
  onSent,
}: {
  initialEmail: string;
  title: ReactNode;
  lead: ReactNode;
  onSent: (email: string) => void;
}) => {
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    setPending(true);
    setFailure(null);
    try {
      await account.sendCode(trimmed);
      onSent(trimmed);
    } catch (error) {
      setFailure(failureMessage(error));
      setPending(false);
    }
  };
  return (
    <form className="flex flex-1 flex-col gap-6" onSubmit={onSubmit}>
      <StepHeading title={title}>{lead}</StepHeading>
      <div>
        <label className="mb-2 block text-sm font-bold" htmlFor="email">
          Email
        </label>
        <input
          autoCapitalize="off"
          autoComplete="email"
          autoCorrect="off"
          className="field"
          id="email"
          inputMode="email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          placeholder="you@example.com"
          required
          spellCheck={false}
          type="email"
          value={email}
        />
      </div>
      <div className="mt-auto flex flex-col gap-3">
        <Failure>{failure}</Failure>
        <button
          className="pill pill-frame w-full"
          disabled={pending || !email.includes("@")}
          type="submit"
        >
          {pending ? "Sending…" : "Send code"}
        </button>
        <Terms />
      </div>
    </form>
  );
};

const CodeStep = ({
  email,
  onSignedIn,
  onChangeEmail,
}: {
  email: string;
  onSignedIn: (me: Me) => void;
  onChangeEmail: () => void;
}) => {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);

  const verify = async (digits: string) => {
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      await account.signIn(email, digits);
      onSignedIn(await account.me());
    } catch (error) {
      setFailure(codeFailureMessage(error));
      setCode("");
      setPending(false);
      field.current?.focus();
    }
  };

  const resend = async () => {
    setFailure(null);
    setNotice(null);
    try {
      await account.sendCode(email);
      setCode("");
      setNotice(`We sent a new code to ${email}.`);
    } catch (error) {
      setFailure(failureMessage(error));
    }
  };

  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.length === CODE_LENGTH && !pending) {
          verify(code);
        }
      }}
    >
      <StepHeading title="Check your email">
        Enter the six-digit code we sent to{" "}
        <b className="text-ink [overflow-wrap:anywhere]">{email}</b>.
      </StepHeading>
      <div>
        <label className="sr-only" htmlFor="code">
          Six-digit code
        </label>
        <input
          autoComplete="one-time-code"
          className="field text-center text-[1.75rem] font-bold tracking-[0.4em] tabular-nums"
          disabled={pending}
          id="code"
          inputMode="numeric"
          maxLength={CODE_LENGTH}
          onChange={(event) => {
            const digits = otpDigits(event.target.value);
            setCode(digits);
            // Six digits, typed or autofilled from Mail, submit on their own.
            if (digits.length === CODE_LENGTH && !pending) {
              verify(digits);
            }
          }}
          pattern="[0-9]*"
          placeholder="000000"
          ref={field}
          value={code}
        />
      </div>
      {notice ? (
        <output className="text-ink block text-[0.9375rem] font-semibold">
          {notice}
        </output>
      ) : null}
      <Failure>{failure}</Failure>
      <div className="mt-auto flex flex-col gap-3">
        <button
          className="pill pill-frame w-full"
          disabled={pending || code.length < CODE_LENGTH}
          type="submit"
        >
          {pending ? "Checking…" : "Continue"}
        </button>
        <div className="flex flex-wrap justify-center gap-3">
          <button
            className="pill pill-sm"
            disabled={pending}
            onClick={resend}
            type="button"
          >
            Resend
          </button>
          <button
            className="pill pill-sm"
            disabled={pending}
            onClick={onChangeEmail}
            type="button"
          >
            Change email
          </button>
        </div>
      </div>
    </form>
  );
};

const YouStep = ({
  me,
  color,
  onColor,
  onDone,
}: {
  me: Me;
  color: PersonColor;
  onColor: (color: PersonColor) => void;
  onDone: (me: Me) => void;
}) => {
  const [name, setName] = useState(me.suggestedName ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The frame takes on the person's own color from here on.
  const shown = useRef(false);
  useEffect(() => {
    if (!shown.current) {
      shown.current = true;
      onColor(color);
    }
  }, [color, onColor]);
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    try {
      onDone(await account.setProfile({ name: name.trim(), color }));
    } catch (error) {
      setFailure(failureMessage(error));
      setPending(false);
    }
  };
  return (
    <form className="flex flex-1 flex-col gap-6" onSubmit={onSubmit}>
      <StepHeading title="Who's tapping?">
        Your name and color are on every tap you send.
      </StepHeading>
      <ProfileFields
        color={color}
        name={name}
        onColor={onColor}
        onName={setName}
      />
      <div className="mt-auto flex flex-col gap-3">
        <Failure>{failure}</Failure>
        <button
          className="pill pill-frame w-full"
          disabled={pending || !name.trim()}
          type="submit"
        >
          {pending ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  );
};

type Step =
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "code"; readonly email: string }
  | { readonly kind: "you"; readonly me: Me };

/**
 * Email → six-digit code → name and color (only when the account has no
 * profile yet). Calls `onDone` once the person is signed in with a profile.
 * The You step's color is the caller's, so it can paint the frame.
 */
export const SignIn = ({
  me,
  color,
  onColor,
  onDone,
  title = "What's your email?",
  lead = "We'll send you a six-digit code. No password.",
}: {
  /** Already signed in without a profile: start at the You step. */
  me?: Me | null;
  color: PersonColor;
  onColor: (color: PersonColor) => void;
  onDone: (me: Me) => void;
  title?: ReactNode;
  lead?: ReactNode;
}) => {
  const [step, setStep] = useState<Step>(() =>
    me ? { kind: "you", me } : { kind: "email", email: "" }
  );
  const signedIn = (next: Me) => {
    if (next.profile) {
      onDone(next);
    } else {
      setStep({ kind: "you", me: next });
    }
  };
  switch (step.kind) {
    case "email": {
      return (
        <EmailStep
          initialEmail={step.email}
          lead={lead}
          onSent={(email) => {
            setStep({ kind: "code", email });
          }}
          title={title}
        />
      );
    }
    case "code": {
      return (
        <CodeStep
          email={step.email}
          onChangeEmail={() => {
            setStep({ kind: "email", email: step.email });
          }}
          onSignedIn={signedIn}
        />
      );
    }
    default: {
      return (
        <YouStep color={color} me={step.me} onColor={onColor} onDone={onDone} />
      );
    }
  }
};
