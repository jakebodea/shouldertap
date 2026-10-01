import { createFileRoute } from "@tanstack/react-router";

import { DocPage, DocSection, EmailLink } from "@/components/document";

export const Route = createFileRoute("/support")({
  component: SupportComponent,
  head: () => ({ meta: [{ title: "Support · Shouldertap" }] }),
});

const link = "text-ink underline underline-offset-[3px]";

function SupportComponent() {
  return (
    <DocPage
      intro={
        <>
          Shouldertap lets the people you live with tap you on the shoulder from
          their phone. Their message covers every screen on your paired Macs
          until you answer, and they see your answer right away. Stuck? Email{" "}
          <EmailLink />.
        </>
      }
      title="Support"
    >
      <DocSection title="How do I pair someone's phone?">
        <p>
          On your Mac, click the Shouldertap mark in the menu bar and choose
          Invite someone. They scan the QR code with their iPhone camera (or you
          send them the link), it opens in Safari, and they enter their name,
          pick a color, and tap Pair this phone. Each invite works once and
          expires after 7 days.
        </p>
      </DocSection>

      <DocSection title="How do I add another Mac?">
        <p>
          On a Mac that's already set up, open the menu and choose Add another
          Mac to get a pairing code. On the new Mac, install Shouldertap and
          paste the code under “Already set up on another Mac?”. The code
          expires after 15 minutes.
        </p>
      </DocSection>

      <DocSection title="My phone forgot the pairing. How do I re-pair?">
        <p>
          The pairing lives in Safari's website data, so clearing it, using a
          Private tab, or switching phones means starting over. Ask the person
          you tap for a new invite and pair again. They can remove your old
          entry from their menu bar so it doesn't linger.
        </p>
      </DocSection>

      <DocSection title="How do I stop someone from tapping me?">
        <p>
          Click the Shouldertap mark in the menu bar. Under “Can tap you”, point
          at the person, click the remove icon, then click Remove. They can't
          tap you again unless you send a new invite. Removing someone doesn't
          delete the taps they already sent right away: those are deleted
          automatically after 90 days, or email us to delete them sooner.
        </p>
      </DocSection>

      <DocSection title="The Mac app won't open">
        <p>
          The app isn't notarized by Apple yet, so macOS blocks the first
          launch. Choose Done, then open System Settings › Privacy & Security,
          scroll down, and click Open Anyway. The{" "}
          <a className={link} href="/download">
            download page
          </a>{" "}
          walks through it. Shouldertap needs macOS 14 Sonoma or later.
        </p>
      </DocSection>

      <DocSection title="How do updates work?">
        <p>
          Shouldertap checks for updates once a day. When one is ready, the menu
          shows “Update available” with an Install button. You can also choose
          Check for Updates… at the bottom of the menu.
        </p>
      </DocSection>

      <DocSection title="How do I delete my data?">
        <p>
          There's no delete button yet. Email <EmailLink /> with your name as
          senders see it and the name of one of your Macs, and we'll delete your
          inbox and everything in it. The{" "}
          <a className={link} href="/privacy">
            Privacy Policy
          </a>{" "}
          explains what's stored.
        </p>
      </DocSection>
    </DocPage>
  );
}
