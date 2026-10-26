import type { Profile } from "@shouldertap/client";
import { swatches } from "@shouldertap/domain";
import { useEffect, useState } from "react";

import { ProfileFields } from "@/components/sign-in";
import { loadSession } from "@/lib/account";
import { failureMessage } from "@/lib/onboarding";

/**
 * Name and color for one person only, with Save and Cancel. `onSave` may
 * throw; its failure shows here and the fields stay open.
 */
export const SendProfileEditor = ({
  initial,
  onSave,
  onCancel,
  saveLabel = "Save",
}: {
  initial: Profile;
  onSave: (profile: Profile) => Promise<void> | void;
  onCancel: () => void;
  saveLabel?: string;
}) => {
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = async () => {
    const name = draft.name.trim();
    if (!name) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await onSave({ name, color: draft.color });
    } catch (error) {
      setFailure(failureMessage(error));
    }
    setPending(false);
  };
  return (
    <div className="flex flex-col gap-4">
      <ProfileFields
        color={draft.color}
        name={draft.name}
        onColor={(color) => {
          setDraft((current) => ({ ...current, color }));
        }}
        onName={(name) => {
          setDraft((current) => ({ ...current, name }));
        }}
      />
      {failure ? (
        <p className="text-destructive text-[0.9375rem]" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button className="pill flex-1" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="pill pill-ink flex-1"
          disabled={pending || !draft.name.trim()}
          onClick={save}
          type="button"
        >
          {pending ? "Saving…" : saveLabel}
        </button>
      </div>
    </div>
  );
};

/** "{lead} {name}" with their swatch, and a Change link. */
export const SeenAs = ({
  lead,
  profile,
  onChange,
}: {
  lead: string;
  profile: Profile;
  onChange: () => void;
}) => (
  <p className="text-tone text-[0.9375rem]">
    <span
      aria-hidden="true"
      className="mr-1.5 inline-block size-3 rounded-full align-[-1px]"
      style={{ background: swatches[profile.color].base }}
    />
    {lead} <strong className="text-ink">{profile.name}</strong> ·{" "}
    <button
      className="text-ink underline underline-offset-[3px]"
      onClick={onChange}
      type="button"
    >
      Change
    </button>
  </p>
);

/** The signed-in person's profile for new connections, once loaded. */
export const useSendDefault = () => {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    const load = async () => {
      const session = await loadSession();
      if (session.kind === "signed-in") {
        setProfile(session.me.sendProfile);
      }
    };
    // The session is a request to the API, an external system.
    load();
  }, []);
  return profile;
};

/**
 * "{person} will see you as …" on an invite, with Change to pick a name and
 * color for just them. `value` is the pick, null for `initial`.
 */
export const ChooseSeenAs = ({
  person,
  initial,
  value,
  onChange,
}: {
  person: string;
  /** Null while it loads, or when signed out: nothing shows. */
  initial: Profile | null;
  value: Profile | null;
  onChange: (profile: Profile) => void;
}) => {
  const [choosing, setChoosing] = useState(false);
  if (!initial) {
    return null;
  }
  if (choosing) {
    return (
      <SendProfileEditor
        initial={value ?? initial}
        onCancel={() => {
          setChoosing(false);
        }}
        onSave={(profile) => {
          onChange(profile);
          setChoosing(false);
        }}
        saveLabel={`Use for ${person}`}
      />
    );
  }
  return (
    <SeenAs
      lead={`${person} will see you as`}
      onChange={() => {
        setChoosing(true);
      }}
      profile={value ?? initial}
    />
  );
};
