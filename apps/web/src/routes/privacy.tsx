import { createFileRoute } from "@tanstack/react-router";

import { DocPage, DocSection, EmailLink } from "@/components/document";

export const Route = createFileRoute("/privacy")({
  component: PrivacyComponent,
  head: () => ({ meta: [{ title: "Privacy Policy · Shouldertap" }] }),
});

// Keep this in step with what the code stores: apps/server/src/schema.ts,
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
          <li>No accounts, no email addresses, no phone numbers.</li>
          <li>No analytics, advertising, or tracking scripts.</li>
          <li>
            We store what the service needs to work: names, colors, the taps you
            send, and the answers to them.
          </li>
          <li>
            Only the people paired to an inbox can see it. We never sell it or
            use it for ads.
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
          When you open the site or the app talks to our servers, your IP
          address is used to deliver the connection and to rate-limit inbox
          creation. Our hosting provider also keeps standard request logs (such
          as time, address requested, IP address, and browser or app version)
          for a limited period, which we use to keep the service running and fix
          problems.
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
            , readable only by your macOS user.
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
        <p>
          Today, inbox data is kept until it is deleted on request. Removing a
          sender or Mac from the menu bar immediately stops it from using the
          inbox, but its name and the taps and answers already sent stay in the
          inbox's history. Unpairing a phone deletes its key from that phone
          only; the sender stays listed on the recipient's Mac until the
          recipient removes them. Used and expired invites stay stored too.
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
