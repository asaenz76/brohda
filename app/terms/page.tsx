import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — brohda.",
  robots: { index: false, follow: false },
};

const EFFECTIVE_DATE = "July 22, 2026";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" effectiveDate={EFFECTIVE_DATE}>
      <section>
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of brohda.
          (&quot;brohda.&quot;, the &quot;App&quot;, the &quot;Service&quot;, &quot;we&quot;, &quot;us&quot;), operated by{" "}
          <strong>[Company Legal Name]</strong> (the &quot;Company&quot;). By accepting an invitation
          to join, creating an account, or otherwise using the Service, you agree to be bound by
          these Terms. If you do not agree, do not use the Service.
        </p>
      </section>

      <section>
        <h2>1. Invite-only, private service</h2>
        <p>
          brohda. is a private, invite-only social platform. Access is granted only to individuals
          invited by an existing member or administrator of a private group. It is not open to the
          general public, is not advertised or offered to the public at large, and we may decline,
          suspend, or revoke access to anyone at any time, for any reason, in our sole discretion.
        </p>
      </section>

      <section>
        <h2>2. What the Service is — and is not</h2>
        <p>
          The Service provides software tools that let a private group of people who know each
          other organize friendly prediction pools, keep score, and track who owes or is owed what
          within the group. The Service includes an in-app &quot;wallet&quot; balance that is a
          <strong> record-keeping tool only</strong> — a running tally of amounts group members and
          administrators have told the App they sent or received using payment methods entirely
          outside the App.
        </p>
        <p>
          <strong>
            The Company is a facilitator of recordkeeping and organization only. The Company is not
            a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling
            operator, or party to any wager, bet, or contest between members.
          </strong>{" "}
          The Company does not accept, hold, custody, transmit, or have access to any member&apos;s
          money at any time.
        </p>
      </section>

      <section>
        <h2>3. All real-money transactions happen off-platform</h2>
        <p>
          Every actual transfer of money — deposits, withdrawals, entry fees, and payouts — occurs
          directly between members, or between a member and a group administrator, using
          third-party payment methods the group chooses (for example, bank transfers, mobile
          payment services, digital wallets, or cash), entirely outside the Service. The Service
          only records that an administrator has confirmed such a transfer occurred; it does not
          initiate, process, guarantee, or reverse any transfer.
        </p>
        <p>
          You acknowledge and agree that:
        </p>
        <ul>
          <li>
            Any payment app, bank, or other third-party service you use to move money between
            members is governed solely by that provider&apos;s own terms and privacy policy, which
            the Company has no control over and no responsibility for.
          </li>
          <li>
            The Company is not responsible for, and bears no liability for, funds that are lost,
            delayed, sent to the wrong recipient, reversed, disputed, or fraudulently obtained
            through any third-party payment method, or for any error, delay, or omission by a group
            administrator in recording such transfers.
          </li>
          <li>
            Balances shown in the App reflect what has been reported and confirmed by group
            administrators and may not reflect real-time or error-free reality. Disputes about
            whether a real-world payment was actually sent or received are between the members
            involved and are not resolved, guaranteed, or insured by the Company.
          </li>
        </ul>
      </section>

      <section>
        <h2>4. Eligibility and your responsibility for legality</h2>
        <p>
          You must be at least 18 years old, or the age of legal majority in your jurisdiction if
          higher, to use the Service. You are solely responsible for determining whether
          participating in prediction pools or similar contests among your private group is lawful
          where you live, and for complying with all applicable laws. The Company makes no
          representation that use of the Service is appropriate or legal in any particular
          jurisdiction, and you agree not to use the Service where doing so would violate
          applicable law.
        </p>
      </section>

      <section>
        <h2>5. Service fee</h2>
        <p>
          A pool may disclose a service fee retained from that pool&apos;s total contributions,
          shown to members before they join. This fee compensates the Company and/or group
          administrators for providing and operating the Service. It is a flat service charge, not
          a wager, stake, or bet placed by the Company on the outcome of any pool.
        </p>
      </section>

      <section>
        <h2>6. Your conduct</h2>
        <p>You agree that you will not:</p>
        <ul>
          <li>
            Invite, or ask to be invited, anyone you do not know and trust, or use the Service to
            solicit participation from the general public.
          </li>
          <li>Use the Service for money laundering, fraud, or any other illegal purpose.</li>
          <li>
            Misrepresent whether a real-world payment was sent or received, or otherwise submit
            false information to a group administrator.
          </li>
          <li>Attempt to manipulate the outcome of any pool or interfere with other members&apos; use of the Service.</li>
          <li>Circumvent, disable, or interfere with any security feature of the Service.</li>
        </ul>
      </section>

      <section>
        <h2>7. Administrator discretion</h2>
        <p>
          Group administrators review and approve or reject wallet activity, resolve disputes about
          pool entries and outcomes, and may correct errors, cancel pools, or reverse recorded
          entries at their discretion in order to keep the group&apos;s records accurate. Their
          good-faith decisions regarding the App&apos;s records are final. This does not affect any
          right you may separately have against another individual member with respect to money
          actually owed between you off-platform.
        </p>
      </section>

      <section>
        <h2>8. No warranty</h2>
        <p>
          The Service is provided &quot;as is&quot; and &quot;as available,&quot; without warranties
          of any kind, whether express, implied, or statutory, including any implied warranties of
          merchantability, fitness for a particular purpose, or non-infringement. We do not warrant
          that the Service will be uninterrupted, error-free, or secure.
        </p>
      </section>

      <section>
        <h2>9. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, the Company and its officers, employees, and
          administrators will not be liable for any indirect, incidental, special, consequential,
          or punitive damages, or any loss of money, data, or goodwill, arising from or related to
          your use of the Service — including, without limitation, any loss arising from an
          off-platform payment made or received between members. To the fullest extent permitted by
          law, the Company&apos;s total aggregate liability for any claim arising out of or relating
          to the Service will not exceed one hundred U.S. dollars (US$100).
        </p>
      </section>

      <section>
        <h2>10. Indemnification</h2>
        <p>
          You agree to indemnify and hold harmless the Company and its administrators from any
          claim, demand, loss, or damages, including reasonable attorneys&apos; fees, arising out of
          your use of the Service, your violation of these Terms, or your violation of any law or
          the rights of a third party, including any dispute over money you sent or received
          off-platform.
        </p>
      </section>

      <section>
        <h2>11. Termination</h2>
        <p>
          We may suspend or terminate your access to the Service at any time, with or without
          notice, for any reason, including if we believe you have violated these Terms. You may
          stop using the Service at any time.
        </p>
      </section>

      <section>
        <h2>12. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. If we make material changes, we will make
          the updated Terms available in the App. Continued use of the Service after a change
          becomes effective constitutes acceptance of the revised Terms.
        </p>
      </section>

      <section>
        <h2>13. Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws of <strong>[Governing Law / Jurisdiction]</strong>,
          without regard to conflict-of-law principles. Any dispute arising out of or relating to
          these Terms or the Service will be resolved exclusively in the courts of that
          jurisdiction, and you consent to their personal jurisdiction.
        </p>
      </section>

      <section>
        <h2>14. Contact</h2>
        <p>
          Questions about these Terms can be sent to{" "}
          <a href="mailto:support@brohda.com" className="underline underline-offset-4">
            support@brohda.com
          </a>
          .
        </p>
      </section>
    </LegalPage>
  );
}
