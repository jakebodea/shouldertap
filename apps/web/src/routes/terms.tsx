import { createFileRoute } from "@tanstack/react-router";

import { DocPage, DocSection, EmailLink } from "@/components/document";

const TermsComponent = () => (
  <DocPage
    effective="October 1, 2026"
    intro="These terms cover your use of Shouldertap: the website at shouldertap.app, the Mac and iPhone apps, and the servers behind them. Shouldertap is run by Jake Bodea, an individual (“we”, “us”). By using Shouldertap you agree to these terms."
    title="Terms of Use"
  >
    <DocSection title="The service">
      <p>
        Shouldertap lets someone you invite send you a short message that covers
        the screens of your paired Macs until you answer, and shows them your
        answer. It needs no account: access comes from invite links and the keys
        stored on each paired device, so keep your devices and invite links to
        yourself.
      </p>
    </DocSection>

    <DocSection title="Price, payment and refunds">
      <ul>
        <li>
          Each inbox (one recipient and their paired Macs) is free for 7 days
          from when it&apos;s created. After that, taps to it pause until
          it&apos;s unlocked.
        </li>
        <li>
          Unlocking is a one-time purchase of US$5, plus tax where it applies,
          made from the Mac app. It unlocks that inbox for as long as
          Shouldertap runs, with no subscription. Senders never pay.
        </li>
        <li>
          Payments are handled by our reseller and merchant of record, Creem,
          which is the seller of record and handles billing and taxes;
          Creem&apos;s terms apply to the purchase itself.
        </li>
        <li>
          If you&apos;re not happy, email <EmailLink /> within 14 days of buying
          for a full refund. A refunded inbox goes back to being paused.
        </li>
      </ul>
    </DocSection>

    <DocSection title="Acceptable use">
      <p>
        Use Shouldertap only with people who want to hear from you. Don&apos;t:
      </p>
      <ul>
        <li>
          Harass, threaten, intimidate, or spam anyone, or send taps someone has
          asked you to stop sending.
        </li>
        <li>
          Pair a Mac you don&apos;t own or aren&apos;t allowed to use, or get
          someone invited without their knowledge.
        </li>
        <li>Send unlawful content, or use taps to deceive or defraud.</li>
        <li>
          Try to access inboxes you weren&apos;t invited to, overload or disrupt
          the service, get around its limits, or probe it for weaknesses without
          permission. Found a security issue? Email us.
        </li>
        <li>Resell the service or use it to send automated messages.</li>
      </ul>
      <p>
        You&apos;re responsible for the taps you send and the people you invite.
      </p>
    </DocSection>

    <DocSection title="Removing access and ending use">
      <p>
        The recipient can remove any sender or Mac from the Mac menu bar at any
        time, and that sender or Mac stops working immediately. A sender can
        unpair their phone at any time, or delete their pairing and message
        history from Help and privacy in the iPhone app. Report abuse through
        the app or by emailing support. You can stop using Shouldertap whenever
        you like; to have an inbox deleted, email <EmailLink />.
      </p>
      <p>
        We may suspend or cut off access, or delete an inbox, if we believe
        these terms have been broken, to protect people or the service, or when
        the law requires it. We may also change or shut down Shouldertap, and
        will try to give notice on the site first when we can.
      </p>
    </DocSection>

    <DocSection title="Provided as is">
      <p>
        Shouldertap is provided “as is” and “as available”, without warranties
        of any kind, express or implied, including fitness for a particular
        purpose, merchantability, and non-infringement, to the fullest extent
        the law allows. We don&apos;t promise it will be uninterrupted,
        error-free, or that any tap will be delivered, shown, or answered in
        time.
      </p>
      <p>
        Don&apos;t rely on Shouldertap for emergencies or anything
        safety-critical. In an emergency, call your local emergency number.
      </p>
    </DocSection>

    <DocSection title="Limitation of liability">
      {/* oxlint-disable-next-line no-warning-comments -- tracked legal follow-up that must stay greppable */}
      {/* TODO(legal): confirm the liability cap amount and currency. */}
      <p>
        To the fullest extent the law allows, Jake Bodea is not liable for any
        indirect, incidental, special, consequential, or punitive damages, or
        for lost data, profits, or opportunities, arising from your use of or
        inability to use Shouldertap, including taps that arrive late, never
        arrive, or interrupt you. Our total liability for any claim about
        Shouldertap is limited to US$50. Some places don&apos;t allow these
        limits, so they may not all apply to you.
      </p>
    </DocSection>

    <DocSection title="Privacy">
      <p>
        The{" "}
        <a
          className="text-ink underline underline-offset-[3px]"
          href="/privacy"
        >
          Privacy Policy
        </a>{" "}
        explains what Shouldertap stores and who can see it.
      </p>
    </DocSection>

    <DocSection title="Changes to these terms">
      <p>
        We may update these terms. When we do, we&apos;ll change the effective
        date above, and for meaningful changes we&apos;ll say so on the site
        before they take effect. Using Shouldertap after a change means you
        accept the updated terms.
      </p>
    </DocSection>

    <DocSection title="Governing law">
      <p>
        These terms are governed by the laws of the State of California, without
        regard to its conflict-of-law rules. Any dispute will be handled in the
        state or federal courts in Orange County, California. Nothing in these
        terms limits rights you have under the laws where you live that
        can&apos;t be waived by contract.
      </p>
    </DocSection>

    <DocSection title="Contact">
      <p>
        Questions about these terms: <EmailLink />.
      </p>
    </DocSection>
  </DocPage>
);

export const Route = createFileRoute("/terms")({
  component: TermsComponent,
  head: () => ({ meta: [{ title: "Terms of Use · Shouldertap" }] }),
});
