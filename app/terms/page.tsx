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
          <strong>brohda</strong> (the &quot;Company&quot;). By creating an account,
          accepting an invitation, or otherwise using the Service, you agree to be bound by
          these Terms. If you do not agree, do not use the Service.
        </p>
      </section>

      <section>
        <h2>1. Access to the Service</h2>
        <p>
          Access is available by invitation from an administrator or, while registration is open,
          by creating an account. We may decline, suspend, or revoke access to anyone at any time,
          for any reason, in our sole discretion.
        </p>
      </section>

      <section>
        <h2>2. What the Service is — and is not</h2>
        <p>
          brohda. is a social network built around real sporting events. brohda. publishes the
          games (&quot;Game Posts&quot;); members make Picks on them, comment, and can challenge
          one another with &quot;Call BS&quot;. Members do not create games or competitions. Where
          it is enabled, the Service also lets two members agree an optional money Position on
          opposing Picks. The Service includes an in-app &quot;wallet&quot; balance. Where the
          optional money functionality is enabled, a member may add funds to their wallet balance
          and may request a withdrawal, in each case using payment methods outside the App and
          subject to an administrator&apos;s review and confirmation. A member who makes or accepts
          an offer commits part of their wallet balance to that Position: the Service records the
          amount as reserved while the Position is open and, once the Market is decided, settles
          the Position by updating the wallet balances of the two members according to the
          Market&apos;s result. If a Position is voided, the reserved amounts are released. The
          Service may deduct a platform fee as described in Section 5. A money Position is private
          to the two members involved and to authorized administrators.
        </p>
        <p>
          <strong>
            The Company is not a bank, money transmitter, payment processor, escrow agent, broker,
            bookmaker, gambling operator, or party to any wager, bet, or contest between members.
          </strong>
        </p>
      </section>

      <section>
        <h2>3. Deposits and withdrawals happen outside the App</h2>
        <p>
          Every actual transfer of money — deposits and withdrawals — occurs between a member and an
          administrator, using third-party payment methods listed in the App (for example, bank transfers, mobile
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
            through any third-party payment method, or for any error, delay, or omission by an
            administrator in recording such transfers.
          </li>
          <li>
            Balances shown in the App reflect what has been reported and confirmed by
            administrators, together with the results of settled Positions, and may not reflect
            real-time or error-free reality. Disputes about
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
          using the Service — including making Picks and any optional money Positions with other
          members — is lawful where you live, and for complying with all applicable laws. The Company makes no
          representation that use of the Service is appropriate or legal in any particular
          jurisdiction, and you agree not to use the Service where doing so would violate
          applicable law.
        </p>
      </section>

      <section>
        <h2>5. Service fee</h2>
        <p>
          Where optional money Positions are enabled, the Service may retain a fee from the losing
          amount of a settled Position. The current rate is shown before you confirm an offer, and
          the rate in effect when a Position was accepted is the one that applies to it. This fee
          compensates the Company for providing and operating the Service. It is a service charge,
          not a wager, stake, or bet placed by the Company on the outcome of any Market.
        </p>
      </section>

      <section>
        <h2>6. Your conduct</h2>
        <p>You agree that you will not:</p>
        <ul>
          <li>Use the Service for money laundering, fraud, or any other illegal purpose.</li>
          <li>
            Misrepresent whether a real-world payment was sent or received, or otherwise submit
            false information to an administrator.
          </li>
          <li>Attempt to manipulate the outcome of any Market, Pick, Call BS, or Position, or interfere with other members&apos; use of the Service.</li>
          <li>Circumvent, disable, or interfere with any security feature of the Service.</li>
        </ul>
      </section>

      <section>
        <h2>7. Administrator discretion</h2>
        <p>
          Administrators review and approve or reject wallet requests, resolve disputes about the
          Service&apos;s records, and may correct errors or reverse recorded entries at their
          discretion in order to keep those records accurate. Their
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
          These Terms are governed by the laws of <strong>Costa Rica</strong>,
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
