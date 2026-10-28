import { createFileRoute } from "@tanstack/react-router";

import { DocPage, DocSection, EmailLink } from "@/components/document";

// Keep this in step with what the code stores: apps/server/src/schema.ts,
// apps/server/src/retention.ts, apps/server/src/Inbox.ts (limits),
// apps/server/src/TrialLedger.ts (one trial per Mac),
// apps/web/src/lib/pairing.ts, apps/web/src/lib/use-sender.ts,
// apps/server/src/analytics.ts (what goes to PostHog), and the Mac app.
const PrivacyComponent = () => (
  <DocPage
    effective="October 28, 2026"
    intro="Shouldertap is run by Jake Bodea, an individual. This page explains what Shouldertap stores, why, and who can see it. It describes how the service works today; if that changes, this page changes first."
    title="Privacy Policy"
  >
    <DocSection title="The short version">
      <ul>
        <li>
          Messaging does not require an account or phone number. An optional
          email account lets you recover connections across devices. New patron
          subscriptions require an account. We also receive email addresses
          through support and billing.
        </li>
        <li>
          No advertising or tracking scripts. Our servers count product events,
          like a tap being sent, in PostHog using random IDs: never your name or
          messages. If you create an account, its email address is attached so
          we can see who signed up.
        </li>
        <li>
          We store what the service needs to work: names, colors, the taps you
          send, and the answers to them.
        </li>
        <li>
          Only the people paired to an inbox can see it. We never sell it or use
          it for ads.
        </li>
        <li>Taps and their answers are deleted automatically after 90 days.</li>
        <li>
          Historical trial records may contain a one-way hardware fingerprint.
          Core messaging is free and no longer uses trials.
        </li>
      </ul>
    </DocSection>

    <DocSection title="Who's who">
      <p>
        The <b>recipient</b> receives taps in an inbox on an iPhone or computer.
        A Mac is not required. A <b>sender</b> is someone the recipient invited,
        who sends taps from the iPhone app or web sender. An account can keep
        recovery links to multiple separate inboxes, sender connections and
        patron memberships; attaching them does not merge inboxes.
      </p>
    </DocSection>

    <DocSection title="What we store on our servers">
      <p>
        If you create an email account, we store your email address,
        verification status, account identifiers and creation/update dates.
        Account sessions include a session token, expiry, IP address and browser
        or app user agent. We store sign-in verification records, device
        authorization codes and status, and rate-limit records to secure
        sign-in. Email links expire after ten minutes; account sessions expire
        after thirty days unless renewed. These expiry periods describe access
        validity, not a promise that every expired database record is
        immediately erased.
      </p>
      <p>
        Cloudflare D1 holds account references to the inboxes, sender
        connections and patron memberships you explicitly attach, their display
        names, your default inbox choice, the two reply options your taps offer
        if you change them, and billing-operation records used to prevent
        duplicate checkout. These references allow account recovery; possession
        of an email address alone does not attach an existing connection.
      </p>
      <p>Each inbox is kept separately and holds:</p>
      <ul>
        <li>The recipient&apos;s name, as shown to senders.</li>
        <li>
          The name of each paired Mac, and of each iPhone the recipient links to
          the inbox, and which of the two it is.
        </li>
        <li>
          For each linked iPhone: the push tokens Apple issues so taps can reach
          it (for notifications and Live Activities), whether Live Activities
          are on, and, while a tap is waiting, its Live Activity&apos;s token.
          They are deleted when the iPhone is removed or the tap is answered.
        </li>
        <li>Each sender&apos;s name and the color they picked.</li>
        <li>
          When the inbox&apos;s free week ends, and if it was bought: the date,
          Creem&apos;s order number and the buyer&apos;s email address.
        </li>
        <li>
          For each paired Mac, linked iPhone and sender: a hashed (SHA-256) copy
          of its access key, when it was paired, when it was last active, and
          when it was removed, if it was. We can&apos;t recover the key itself
          from the hash.
        </li>
        <li>
          Invites: a hashed secret, who created it, and when it was created,
          expires, and was used.
        </li>
        <li>
          Every tap: the message (up to 280 characters), who sent it, when it
          was sent, when it appeared on screen, when it was answered and on
          which Mac, the two reply options it offered if the sender changed
          them, and the answer (On it, In 10 min, one of those options, or the
          reply text).
        </li>
      </ul>
      <p>
        Historical trial records contain a salted, one-way hardware fingerprint
        and the original trial end. Core messaging is now free: the server no
        longer looks up or creates trial records. Older apps may still send a
        fingerprint during setup, which the server ignores. Existing purchase
        records remain. For patrons we store Creem subscription, customer,
        transaction and event IDs, paid-period dates, and signed billing
        lifecycle facts to show membership and handle renewals, cancellations
        and refunds. A patron membership is separate from any inbox and can be
        attached to an email account for recovery. Your browser or app keeps a
        membership key; we keep its hash and usage dates. Each tap stores the
        theme it was sent with. Payment details stay with Creem. Older inboxes
        may still hold the first answered tap’s date, a count of answers and a
        support prompt time from an earlier version; they are no longer used.
      </p>
      <p>
        When you open the site or the app talks to our servers, your IP address
        is used to deliver the connection and to rate-limit inbox creation and
        sign-in. It is not stored with your inbox, but account session records
        can contain your IP address and user agent. Our hosting provider also
        keeps standard request logs (such as time, address requested, IP
        address, and browser or app version) for a limited period, which we use
        to keep the service running and fix problems.
      </p>
    </DocSection>

    <DocSection title="Support and abuse reports">
      <p>
        If you send a support request or abuse report, we receive your email
        address, your message, and any pairing IDs, tap IDs, screenshots or
        attachments you choose to include. We use these to answer your request,
        investigate abuse, and protect the service. An in-app draft is not sent
        automatically; you choose when and how to send it.
      </p>
      <p>
        Support correspondence is held in our email and support tools,
        separately from your Shouldertap inbox. Deleting a sender pairing does
        not delete copies you sent to support. To request deletion of that
        correspondence, email <EmailLink />. We retain it as needed to resolve
        the request, handle abuse or security issues, or meet legal obligations.
      </p>
    </DocSection>

    <DocSection title="What stays on your devices">
      <ul>
        <li>
          <b>Sender&apos;s phone:</b> The iPhone app stores access keys in the
          iOS Keychain and unsent taps in its app storage. Safari&apos;s local
          storage holds the pairing (your name, color, the recipient&apos;s
          name, and your access key) and any taps that haven&apos;t reached the
          server yet. Unpairing removes the pairing from the phone; clearing
          Safari&apos;s website data removes everything stored there.
        </li>
        <li>
          <b>Recipient&apos;s Mac:</b> signed builds keep the messaging key in
          the Keychain. Ad-hoc development builds keep it in{" "}
          <span className="break-all">
            ~/Library/Application Support/Shouldertap
          </span>
          , readable only by your macOS user. When you set up a new inbox, it
          reads the Mac&apos;s hardware ID to compute the trial fingerprint
          described above; the hardware ID itself never leaves the Mac.
        </li>
        <li>
          <b>Recipient&apos;s iPhone, if linked:</b> the iPhone app keeps the
          inbox&apos;s access key in the iOS Keychain, on that phone only.
          Unlinking removes the active key from the phone. Account inbox
          switching also saves previous inbox keys in the device&apos;s Keychain
          for reuse after account ownership and key validity are checked.
        </li>
        <li>
          <b>Account sign-in:</b> native apps keep account session tokens in the
          Keychain. The browser uses an HttpOnly session cookie; sender and
          membership keys remain in the sender site&apos;s local storage.
          Signing out removes the account session on that device; it does not
          erase messaging connections or saved inbox keys.
        </li>
      </ul>
    </DocSection>

    <DocSection title="Who can see what">
      <ul>
        <li>
          The recipient&apos;s paired Macs, and iPhones they link to the inbox,
          see the inbox: its senders, devices, and taps with their answers.
        </li>
        <li>
          A sender sees the taps they sent and the answers to them, and the
          recipient&apos;s name. Devices restored to the same sender connection
          share that sender&apos;s history.
        </li>
        <li>
          Signing in to an account lets its holder restore access to the
          inboxes, sender connections and patron memberships previously attached
          to that account. Keep your email account and sign-in links private.
        </li>
        <li>
          Jake Bodea, as the operator, can technically access stored data, and
          does so only to run, secure, or debug the service, to answer a support
          request, or when the law requires it.
        </li>
      </ul>
    </DocSection>

    <DocSection title="Service providers">
      <ul>
        <li>
          <b>Creem</b> is our merchant of record and processes purchases. Your
          card details and billing address go to Creem, not to us. Creem tells
          us billing identifiers and subscription events so we can show patron
          status and handle support. Historical inbox purchases may also retain
          an order number and buyer&apos;s email address. Creem&apos;s privacy
          policy covers what it does with payment data.
        </li>
        <li>
          <b>Cloudflare</b> hosts the website, the servers, and the stored data,
          serves Mac app downloads and updates, and delivers account sign-in
          email. Sign-in email contains your email address and a private,
          one-time confirmation link.
        </li>
        <li>
          <b>Apple Push Notification service</b> delivers taps to a linked
          iPhone. Apple receives the sender&apos;s name and color and the
          tap&apos;s text to show it on the phone.
        </li>
        <li>
          <b>PostHog</b> receives product events from our servers, not from your
          browser or device: when an account or inbox is created, an invite is
          accepted, a tap is sent or answered (and which quick reply or a text
          reply was used, but not its text), and patron subscription changes.
          Each event carries only random IDs (account, inbox, sender, device,
          tap), whether a tap used a theme, the device type, and the time. When
          you create an email account, its email address is added to that
          account&apos;s PostHog profile. Deleting the account removes it from
          that profile; past sign-up events keep it until you ask us to erase
          them. Names, tap text and replies are never sent, nor is your IP
          address. We use these events to understand how Shouldertap is used and
          to notify ourselves of sign-ups and subscriptions.
        </li>
        <li>
          Support mail is routed through Cloudflare and forwarded to Gmail,
          where we handle your request. Reports are not published or used for
          advertising.
        </li>
        <li>
          The Mac app checks for updates once a day using Sparkle, which asks
          download.shouldertap.app for the latest version. That request includes
          your IP address and the app&apos;s version, like any web request. No
          other information about your Mac is sent.
        </li>
      </ul>
      <p>
        Fonts and icons are served from shouldertap.app itself. The site loads
        nothing from other companies.
      </p>
    </DocSection>

    <DocSection title="How long we keep it">
      <p>Once a day, each inbox deletes old data on its own:</p>
      <ul>
        <li>
          <b>Taps and their answers</b> are deleted 90 days after the tap was
          sent.
        </li>
        <li>
          <b>Invites</b> are deleted a day after they expire, whether or not
          they were used. Sender invites expire after 7 days; Mac invites after
          15 minutes.
        </li>
        <li>
          <b>Removed senders and Macs</b> (their name, color, hashed key and
          dates) are deleted 90 days after removal, once none of their taps
          remain.
        </li>
        <li>
          One-time connection tickets, which last a minute, are deleted once
          they expire.
        </li>
      </ul>
      <p>
        Everything else (the recipient&apos;s name, and the senders and Macs
        still paired) is kept while the inbox exists, until it is deleted on
        request. Removing a sender or Mac from the menu bar immediately stops it
        from using the inbox; its taps stay in the inbox&apos;s history until
        they reach 90 days. Unpairing a sender device removes that device&apos;s
        key; other restored sender devices can remain connected. Removing the
        sender as a whole blocks all its devices. If a device is offline, it may
        only forget its local key until the server receives the removal.
        Deletion can run up to a day late, and our hosting provider keeps
        recovery copies of stored data for up to 30 days, so deleted data can
        remain in those copies for that long.
      </p>
      <p>
        <b>Trial records</b> (a Mac&apos;s fingerprint and when its free week
        ends) are historical records and are no longer used to gate messaging.
        Deleting an inbox does not delete these separate records. For questions
        or requests about retained historical records, contact us.
      </p>
    </DocSection>

    <DocSection title="Deleting your data">
      <p>
        In Account on iPhone or Mac, or the web account portal, choose “Delete
        account” and confirm. This deletes the email account, its sessions and
        recovery references, and removes its email address from its PostHog
        profile (email us to erase it from past analytics events too). It does
        not delete existing messaging connections, inboxes or messages, or
        automatically cancel billing. An active subscription or unresolved
        checkout must be managed before account deletion; contact support if
        needed. You may need to sign in again.
      </p>
      <p>
        In the iPhone app, open Help and privacy and choose “Delete my data” for
        each person you are paired with. This deletes your sender name, pairing,
        messages, and their replies from the server and this phone. Unpairing
        alone stops contact but does not delete past messages. To delete an
        entire Mac inbox, ask about a pairing you already removed, or ask what
        we hold about you, email <EmailLink />. Include your name as senders see
        it and the name of one of your Macs so we can find the right inbox.
        Recovery copies may remain for up to 30 days.
      </p>
    </DocSection>

    <DocSection title="Limits">
      <p>
        To keep the service fair and to limit abuse, each sender can send up to
        30 taps in any hour, and each inbox can have up to 20 senders and 10
        devices (Macs and linked iPhones) at once. Inbox creation is
        rate-limited per network. Messages and text replies are checked against
        a small set of threatening and abusive phrases before being stored. This
        happens on our servers; no message is sent to an external moderation
        service. These limits are enforced by counting what the inbox already
        stores; they don&apos;t need any extra data about you.
      </p>
    </DocSection>

    <DocSection title="Children">
      <p>
        Shouldertap is meant for households, and a parent may invite their child
        as a sender. It isn&apos;t directed at children, and we don&apos;t
        knowingly collect more about anyone than described here.
      </p>
    </DocSection>

    <DocSection title="Security">
      <p>
        Connections are encrypted with HTTPS. Messaging and membership keys are
        stored as hashes on our side; account session tokens are stored
        separately to authenticate sessions. Taps are not end-to-end encrypted:
        our servers can read them, because they deliver them. Don&apos;t send
        passwords or other secrets in a tap.
      </p>
    </DocSection>

    <DocSection title="Changes">
      <p>
        If this policy changes, we&apos;ll update this page and its effective
        date. If a change affects data you&apos;ve already given us in a
        meaningful way, we&apos;ll say so on the site before it takes effect.
      </p>
    </DocSection>

    <DocSection title="Contact">
      <p>
        Questions or requests: <EmailLink />.
      </p>
    </DocSection>
  </DocPage>
);

export const Route = createFileRoute("/privacy")({
  component: PrivacyComponent,
  head: () => ({ meta: [{ title: "Privacy Policy · Shouldertap" }] }),
});
