import { createFileRoute } from "@tanstack/react-router";

import { DocPage, DocSection, EmailLink } from "@/components/document";

const link = "text-ink underline underline-offset-[3px]";

const SupportComponent = () => (
  <DocPage
    intro={
      <>
        Shouldertap lets the people you live with tap you on the shoulder from
        their phone. You can receive and answer on an iPhone without a Mac, or
        on your paired computers. Senders see your answer right away. Stuck?
        Email <EmailLink />.
      </>
    }
    title="Support"
  >
    <DocSection title="Support Shouldertap">
      <p>
        Core messaging is free. Optional patron support helps cover running
        costs: $2/month, billed $24 annually in USD, plus applicable tax. It
        renews annually until canceled. It belongs to whoever sends taps: while
        it’s active, your taps can use a theme (Broadsheet, Billboard, Terminal
        or Note) on the screens of everyone you tap. They never pay to see it,
        and can always show taps plain. Sending, replies and the Default look
        never need it, and themes aren’t a permanent purchase. It is not a
        tax-deductible donation.
      </p>
      <p>
        In the web sender, open Style under the message field. Preview every
        theme, then use “Become a patron” to open Account. Sign in by email,
        save any existing browser membership to your account, and continue to
        patron support to check out with Creem. “Manage billing” lets you change
        your payment method, see receipts or cancel. Cancellation takes effect
        at the end of your paid period; taps already sent keep their theme. Use
        “Add another device” to add your membership to another phone or browser
        with a one-time code, or restore an attached membership from Account.
        After subscribing in Account, return to the sender site&apos;s Account
        page, load your connections and add your membership to this browser
        before choosing a theme in Style. For billing help, a lost device, or a
        refund within 14 days of a support payment, email <EmailLink />.
      </p>
      <p>
        If you bought annual support from your computer before it moved to
        senders, manage or cancel it there under “Patron themes”.
      </p>
      <p>
        If you previously paid $5, thank you. Your purchase is preserved and you
        have not been enrolled in an annual subscription.
      </p>
    </DocSection>
    <DocSection title="Do I need an account or a Mac?">
      <p>
        Neither is required for messaging. An email account lets you save and
        recover inboxes, sender connections and patron memberships. Open Account
        on iPhone or Mac, or follow the Account link on the website. Native apps
        show a code to confirm in your browser after email sign-in. Explicitly
        attach this device&apos;s existing connections to make them recoverable.
        Multiple inboxes remain separate; you can choose a default and select
        which inbox a receiving device uses. New patron subscriptions require an
        account. The iPhone app offers external patron signup only for the
        United States App Store storefront.
      </p>
    </DocSection>
    <DocSection title="How do I pair someone's phone?">
      <p>
        On your Mac, click the Shouldertap mark in the menu bar and choose
        Invite someone. In the iPhone app, choose “I have an invite” and scan
        that QR code or paste the link you send them. They enter a name, pick a
        color, and pair. They can also open the link in Safari to use the web
        sender. Each invite works once and expires after 7 days.
      </p>
    </DocSection>

    <DocSection title="Can one phone tap more than one person?">
      <p>
        Yes. In the iPhone app, tap the person-with-plus button at the top to
        add someone, then scan the QR code on their Mac or paste the invite link
        they sent. Tap a recipient’s avatar to switch between people. In Safari,
        tap the name at the top and choose Add someone.
      </p>
    </DocSection>

    <DocSection title="How do I add another Mac?">
      <p>
        On a Mac that&apos;s already set up, open the menu and choose Add
        another Mac to get a pairing code. On the new Mac, install Shouldertap
        and paste the code under “Already set up on another Mac?”. The code
        expires after 15 minutes.
      </p>
    </DocSection>

    <DocSection title="My phone forgot the pairing. How do I re-pair?">
      <p>
        The iPhone app keeps pairing keys in the iOS Keychain; the web sender
        keeps its pairing in Safari’s website data. Clearing Safari data or
        using a Private tab can remove the web pairing. If a pairing is missing
        or you switch phones, sign in to Account and restore a connection you
        previously attached. On the website, return to Account after sign-in,
        load your connections and add the one you want to this browser. If it
        was never attached, ask for a new invite and pair again. The recipient
        can remove old devices or sender connections.
      </p>
    </DocSection>

    <DocSection title="How do I stop someone from tapping me?">
      <p>
        Click the Shouldertap mark in the menu bar. Under “Can tap you”, point
        at the person, click the remove icon, then click Remove. They can&apos;t
        tap you again unless you send a new invite. Removing someone
        doesn&apos;t delete the taps they already sent right away: those are
        deleted automatically after 90 days, or email us to delete them sooner.
      </p>
    </DocSection>

    <DocSection title="The Mac app won't open">
      <p>
        Download the latest version from our site. It is signed and notarized by
        Apple. Open the disk image, drag Shouldertap to Applications, and choose
        Open when macOS asks about the downloaded app. The{" "}
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

    <DocSection title="Report abuse">
      <p>
        In the iPhone app, open Help and privacy, then “Report a problem or
        abuse”. You can also press and hold a recent tap to email a report with
        its tap ID. Email <EmailLink /> with the details you want to share. We
        review reports and can remove content or revoke access. To stop contact
        immediately, unpair on iPhone or remove a sender under “Can tap you” in
        the Mac app. A new invite is required to reconnect.
      </p>
    </DocSection>
    <DocSection title="How do I delete my data?">
      <p>
        To delete your email account, open Account on iPhone or Mac, or the web
        account portal, choose “Delete account” and confirm. This deletes
        account recovery links and sessions, while existing messaging
        connections remain on their devices. Account deletion does not cancel
        billing or delete inboxes and messages. Manage active subscriptions or
        unresolved checkout before deletion; you may need to sign in again.
        Contact support if a pending checkout prevents deletion.
      </p>
      <p>
        In the iPhone app, open Help and privacy and choose “Delete my data” for
        each person you are paired with. This deletes your sender pairing,
        messages and replies. For an entire Mac inbox or an old pairing you
        already removed, email <EmailLink /> with your name as senders see it
        and the name of one of your Macs. The{" "}
        <a className={link} href="/privacy">
          Privacy Policy
        </a>{" "}
        explains what&apos;s stored.
      </p>
    </DocSection>
  </DocPage>
);

export const Route = createFileRoute("/support")({
  component: SupportComponent,
  head: () => ({ meta: [{ title: "Support · Shouldertap" }] }),
});
