import { createFileRoute } from "@tanstack/react-router";

import { DocPage, DocSection, EmailLink } from "@/components/document";

export const Route = createFileRoute("/privacy")({
  component: PrivacyComponent,
  head: () => ({ meta: [{ title: "Privacy Policy · Shouldertap" }] }),
});

// Keep this in step with what the code stores: apps/server/src/schema.ts,
// apps/server/src/retention.ts, apps/server/src/Inbox.ts (limits),
// apps/server/src/TrialLedger.ts (one trial per Mac),
// apps/web/src/lib/pairing.ts, apps/web/src/lib/use-sender.ts, and the Mac app.
function PrivacyComponent() {
  return (
    <DocPage
      effective="October 1, 2026"
      intro="Shouldertap is run by Jake Bodea, an individual. This page explains what Shouldertap stores, why, and who can see it. It describes how the service works today; if that changes, this page changes first."
      title="Privacy Policy"
    >
      <DocSection title="The short version">
        <ul>
          <li>
            No accounts or phone numbers. The only email address we keep is the
            one you give when you buy, so we can restore your purchase.
          </li>
          <li>No analytics, advertising, or tracking scripts.</li>
          <li>
            We store what the service needs to work: names, colors, the taps you
            send, and the answers to them.
          </li>
          <li>
            Only the people paired to an inbox can see it. We never sell it or
            use it for ads.
          </li>
          <li>
            Taps and their answers are deleted automatically after 90 days.
          </li>
          <li>
            So each Mac gets one free week, we keep a one-way fingerprint of the
            Mac's hardware ID, never the ID itself.
          </li>
        </ul>
      </DocSection>

      <DocSection title="Who's who">
        <p>
          The <b>recipient</b> installs the Mac app. Each recipient has one
          inbox. A <b>sender</b> is someone the recipient invited, who sends
          taps from Safari on their phone.
        </p>
      </DocSection>

      <DocSection title="What we store on our servers">
        <p>Each inbox is kept separately and holds:</p>
        <ul>
          <li>The recipient's name, as shown to senders.</li>
          <li>The name of each paired Mac.</li>
          <li>Each sender's name and the color they picked.</li>
          <li>
            When the inbox's free week ends, and if it was bought: the date,
            Creem's order number and the buyer's email address.
          </li>
          <li>
            For each paired Mac and sender: a hashed (SHA-256) copy of its
            access key, when it was paired, when it was last active, and when it
            was removed, if it was. We can't recover the key itself from the
            hash.
          </li>
          <li>
            Invites: a hashed secret, who created it, and when it was created,
            expires, and was used.
          </li>
          <li>
            Every tap: the message (up to 280 characters), who sent it, when it
            was sent, when it appeared on screen, when it was answered and on
            which Mac, and the answer (On it, In 10 min, or the reply text).
          </li>
        </ul>
        <p>
          Separately from any inbox, we keep a <b>trial record</b> for each Mac
          that has set up an inbox: a fingerprint of that Mac and the date its
          free week ends. This is what stops removing Shouldertap and setting it
          up again from starting a new free week. The fingerprint is a one-way
          hash (SHA-256) of the Mac's hardware ID, salted with a value unique to
          Shouldertap, so the hardware ID can't be recovered from it and it
          can't be matched with what other apps see. The record holds nothing
          else: no names, no inbox, no IP address. Only the Mac app sends a
          fingerprint, and only when it sets up a new inbox; joining an existing
          inbox from a second Mac doesn't.
        </p>
        <p>
          When you open the site or the app talks to our servers, your IP
          address is used to deliver the connection and to rate-limit inbox
          creation; it isn't stored with your inbox. Our hosting provider also
          keeps standard request logs (such as time, address requested, IP
          address, and browser or app version) for a limited period, which we
          use to keep the service running and fix problems.
        </p>
      </DocSection>

      <DocSection title="What stays on your devices">
        <ul>
          <li>
            <b>Sender's phone:</b> Safari's local storage holds the pairing
            (your name, color, the recipient's name, and your access key) and
            any taps that haven't reached the server yet. Unpairing removes the
            pairing from the phone; clearing Safari's website data removes
            everything stored there.
          </li>
          <li>
            <b>Recipient's Mac:</b> the app keeps its access key in{" "}
            <span className="break-all">
              ~/Library/Application Support/Shouldertap
            </span>
            , readable only by your macOS user. When you set up a new inbox, it
            reads the Mac's hardware ID to compute the trial fingerprint
            described above; the hardware ID itself never leaves the Mac.
          </li>
        </ul>
      </DocSection>

      <DocSection title="Who can see what">
        <ul>
          <li>
            The recipient's paired Macs see the inbox: its senders, Macs, and
            taps with their answers.
          </li>
          <li>
            A sender sees the taps they sent and the answers to them, and the
            recipient's name.
          </li>
          <li>
            Jake Bodea, as the operator, can technically access stored data, and
            does so only to run, secure, or debug the service, to answer a
            support request, or when the law requires it.
          </li>
        </ul>
      </DocSection>

      <DocSection title="Service providers">
        <ul>
          <li>
            <b>Creem</b> is our merchant of record and processes purchases. Your
            card details and billing address go to Creem, not to us. Creem tells
            us that an inbox was paid for, the order number, and the buyer's
            email address, which we keep with the inbox to restore the purchase
            on a new Mac and to answer support requests. Creem's privacy policy
            covers what it does with payment data.
          </li>
          <li>
            <b>Cloudflare</b> hosts the website, the servers, and the stored
            data, and serves Mac app downloads and updates.
          </li>
          <li>
            The Mac app checks for updates once a day using Sparkle, which asks
            download.shouldertap.app for the latest version. That request
            includes your IP address and the app's version, like any web
            request. No other information about your Mac is sent.
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
            they were used. Sender invites expire after 7 days; Mac invites
            after 15 minutes.
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
          Everything else (the recipient's name, and the senders and Macs still
          paired) is kept while the inbox exists, until it is deleted on
          request. Removing a sender or Mac from the menu bar immediately stops
          it from using the inbox; its taps stay in the inbox's history until
          they reach 90 days. Unpairing a phone deletes its key from that phone
          and removes the sender from the recipient's Mac, the same as the
          recipient removing them (if the phone is offline, only the phone
          forgets it). Deletion can run up to a day late, and our
          hosting provider keeps recovery copies of stored data for up to 30
          days, so deleted data can remain in those copies for that long.
        </p>
        <p>
          <b>Trial records</b> (a Mac's fingerprint and when its free week ends)
          are kept for as long as Shouldertap offers one free week per Mac,
          because deleting one would give that Mac a new free week. Deleting an
          inbox doesn't delete them; they aren't linked to any inbox.
        </p>
      </DocSection>

      <DocSection title="Deleting your data">
        <p>
          There is no delete button yet. To delete an inbox and everything in
          it, or to ask what we hold about you, email <EmailLink />. If you're
          the recipient, include your name as senders see it and the name of one
          of your Macs so we can find the right inbox. Senders can ask too, and
          we'll work with the recipient to remove their taps.
        </p>
      </DocSection>

      <DocSection title="Limits">
        <p>
          To keep the service fair and to limit abuse, each sender can send up
          to 30 taps in any hour, and each inbox can have up to 20 senders and
          10 Macs paired at once. Inbox creation is rate-limited per network.
          These limits are enforced by counting what the inbox already stores;
          they don't need any extra data about you.
        </p>
      </DocSection>

      <DocSection title="Children">
        <p>
          Shouldertap is meant for households, and a parent may invite their
          child as a sender. It isn't directed at children, and we don't
          knowingly collect more about anyone than described here.
        </p>
      </DocSection>

      <DocSection title="Security">
        <p>
          Connections are encrypted with HTTPS. Access keys are stored only as
          hashes on our side. Taps are not end-to-end encrypted: our servers can
          read them, because they deliver them. Don't send passwords or other
          secrets in a tap.
        </p>
      </DocSection>

      <DocSection title="Changes">
        <p>
          If this policy changes, we'll update this page and its effective date.
          If a change affects data you've already given us in a meaningful way,
          we'll say so on the site before it takes effect.
        </p>
      </DocSection>

      <DocSection title="Contact">
        <p>
          Questions or requests: <EmailLink />.
        </p>
      </DocSection>
    </DocPage>
  );
}
