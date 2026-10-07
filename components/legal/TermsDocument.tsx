import type { ReactNode } from "react";
import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { byMode, byModeLazy, type LegalMoneyMode } from "@/lib/legal/money-mode";

// The Terms of Service, composed per money mode (lib/legal/money-mode.ts) at SECTION level:
//
//   active    optional money is on — the complete Terms.
//   retained  optional money is off but financial records still exist — no current-feature copy (no offers, funding, settlement mechanics or fee
//             explanation), but the stable disclosure the records require: what is kept, how an existing balance is withdrawn, who is responsible
//             for off-platform transfers, administrator authority over the records, and what ending an account does not erase.
//   free      money is off and nothing financial was ever stored — no money language at all except the Company's own classification disclaimer.
//
// Every section declares which modes include it; numbering and cross-references are derived from the sections actually shown, so a sentence can
// never point at a section that is hidden. Every variant is explicit (byMode requires all three), so money copy cannot leak into a mode by default.
// All wording marked OWNER/COUNSEL REVIEW REQUIRED in docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md stays exactly as it was in `active`.

type Ref = (id: SectionId) => string;
type SectionId = "access" | "service" | "payments" | "records" | "eligibility" | "fee" | "conduct" | "admin" | "warranty" | "liability" | "indemnity" | "termination" | "changes" | "law" | "contact";

interface SectionDef {
  id: SectionId;
  title: string;
  modes: readonly LegalMoneyMode[];
  body: (ctx: { mode: LegalMoneyMode; ref: Ref }) => ReactNode;
}

const ALL: readonly LegalMoneyMode[] = ["active", "retained", "free"];

const SECTIONS: readonly SectionDef[] = [
  {
    id: "access",
    title: "Access to the Service",
    modes: ALL,
    body: () => (
      <p>
        Access is available by invitation from an administrator or, while registration is open,
        by creating an account. We may decline, suspend, or revoke access to anyone at any time,
        for any reason, in our sole discretion.
      </p>
    ),
  },
  {
    id: "service",
    title: "What the Service is — and is not",
    modes: ALL,
    body: ({ mode, ref }) => (
      <>
        <p>
          brohda. is a social network built around real sporting events. brohda. publishes the
          games (&quot;Game Posts&quot;); members make Picks on them, comment, and can challenge
          one another with &quot;Call BS&quot;. Members do not create games or competitions.
          {byModeLazy(mode, {
            active: () => (
              <>
                {" "}
                Where it is enabled, the Service also lets two members agree an optional money Position on
                opposing Picks. The Service includes an in-app &quot;wallet&quot; balance. Where the
                optional money functionality is enabled, a member may add funds to their wallet balance
                and may request a withdrawal, in each case using payment methods outside the App and
                subject to an administrator&apos;s review and confirmation. A member who makes or accepts
                an offer commits part of their wallet balance to that Position: the Service records the
                amount as reserved while the Position is open and, once the Market is decided, settles
                the Position by updating the wallet balances of the two members according to the
                Market&apos;s result. If a Position is voided, the reserved amounts are released. The
                Service may deduct a platform fee as described in Section {ref("fee")}. A money Position is private
                to the two members involved and to authorized administrators.
              </>
            ),
            retained: () => <> The Service also keeps wallet records, described in Section {ref("records")}.</>,
            free: () => null,
          })}
        </p>
        <p>
          <strong>
            The Company is not a bank, money transmitter, payment processor, escrow agent, broker,
            bookmaker, gambling operator, or party to any wager, bet, or contest between members.
          </strong>
        </p>
      </>
    ),
  },
  {
    id: "payments",
    title: "Deposits and withdrawals happen outside the App",
    modes: ["active"],
    body: () => (
      <>
        <p>
          Every actual transfer of money — deposits and withdrawals — occurs between a member and an
          administrator, using third-party payment methods listed in the App (for example, bank transfers, mobile
          payment services, digital wallets, or cash), entirely outside the Service. The Service
          only records that an administrator has confirmed such a transfer occurred; it does not
          initiate, process, guarantee, or reverse any transfer.
        </p>
        <p>You acknowledge and agree that:</p>
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
      </>
    ),
  },
  {
    id: "records",
    title: "Wallet records and withdrawals",
    modes: ["retained"],
    body: () => (
      <>
        <p>
          The Service keeps the wallet and money records from earlier activity: wallet balances, amounts that were held for a
          Position, the results of settled or voided Positions, any fee retained from a settled Position, withdrawal requests,
          and the entries an administrator recorded when confirming a deposit or withdrawal. These are kept as permanent records
          of the Service&apos;s ledger, as described in our Privacy Policy.
        </p>
        <p>
          Where a member still has a balance, a withdrawal is paid by an administrator, after review and confirmation, using a
          third-party payment method outside the App. The Service only records that an administrator has confirmed such a
          transfer occurred; it does not initiate, process, guarantee, or reverse any transfer.
        </p>
        <p>You acknowledge and agree that:</p>
        <ul>
          <li>
            Any payment app, bank, or other third-party service used to receive a withdrawal is governed solely by that
            provider&apos;s own terms and privacy policy, which the Company has no control over and no responsibility for.
          </li>
          <li>
            The Company is not responsible for, and bears no liability for, funds that are lost, delayed, sent to the wrong
            recipient, reversed, disputed, or fraudulently obtained through any third-party payment method, or for any error,
            delay, or omission by an administrator in recording such transfers.
          </li>
          <li>
            Balances shown in the App reflect what has been reported and confirmed by administrators, together with the
            results of settled Positions, and may not reflect real-time or error-free reality.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Eligibility and your responsibility for legality",
    modes: ALL,
    body: ({ mode }) => (
      <p>
        You must be at least 18 years old, or the age of legal majority in your jurisdiction if
        higher, to use the Service. You are solely responsible for determining whether
        using the Service — including{" "}
        {byMode(mode, {
          active: "making Picks and any optional money Positions with other members",
          retained: "making Picks and commenting",
          free: "making Picks and commenting",
        })}{" "}
        — is lawful where you live, and for complying with all applicable laws. The Company makes no
        representation that use of the Service is appropriate or legal in any particular
        jurisdiction, and you agree not to use the Service where doing so would violate
        applicable law.
      </p>
    ),
  },
  {
    id: "fee",
    title: "Service fee",
    modes: ["active"],
    body: () => (
      <p>
        Where optional money Positions are enabled, the Service may retain a fee from the losing
        amount of a settled Position. The current rate is shown before you confirm an offer, and
        the rate in effect when a Position was accepted is the one that applies to it. This fee
        compensates the Company for providing and operating the Service. It is a service charge,
        not a wager, stake, or bet placed by the Company on the outcome of any Market.
      </p>
    ),
  },
  {
    id: "conduct",
    title: "Your conduct",
    modes: ALL,
    body: ({ mode, ref }) => (
      <>
        <p>You agree that you will not:</p>
        <ul>
          <li>Harass, threaten, or abuse other people, or post content that attacks people for who they are.</li>
          <li>Post spam or scams, or pretend to be someone else.</li>
          <li>Post unlawful content, or other people&apos;s private information.</li>
          <li>Use the Service for money laundering, fraud, or any other illegal purpose.</li>
          {byMode(mode, {
            active: (
              <li>
                Misrepresent whether a real-world payment was sent or received, or otherwise submit
                false information to an administrator.
              </li>
            ),
            retained: (
              <li>
                Misrepresent whether a real-world payment was sent or received, or otherwise submit
                false information to an administrator.
              </li>
            ),
            free: <li>Submit false information to an administrator.</li>,
          })}
          <li>
            {byMode(mode, {
              active: "Attempt to manipulate the outcome of any Market, Pick, Call BS, or Position, or interfere with other members' use of the Service.",
              retained: "Attempt to manipulate the outcome of any Market, Pick, or Call BS, or interfere with other members' use of the Service.",
              free: "Attempt to manipulate the outcome of any Market, Pick, or Call BS, or interfere with other members' use of the Service.",
            })}
          </li>
          <li>Circumvent, disable, or interfere with any security feature of the Service.</li>
        </ul>
        <p>
          We and our moderators may remove content, including comments, that we consider to break
          these rules or to be harmful to members or to the Service. We may also suspend or close
          an account at our discretion, with or without notice (see Section {ref("termination")}).
          If you see something that breaks these rules, tell us at{" "}
          <a href="mailto:support@brohda.com" className="underline underline-offset-4">
            support@brohda.com
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "admin",
    title: "Administrator discretion",
    modes: ALL,
    body: ({ mode }) =>
      byMode(mode, {
        active: (
          <p>
            Administrators review and approve or reject wallet requests, resolve disputes about the
            Service&apos;s records, and may correct errors or reverse recorded entries at their
            discretion in order to keep those records accurate. Their
            good-faith decisions regarding the App&apos;s records are final. This does not affect any
            right you may separately have against another individual member with respect to money
            actually owed between you off-platform.
          </p>
        ),
        retained: (
          <p>
            Administrators review and approve or reject wallet requests, resolve disputes about the
            Service&apos;s records, and may correct errors or reverse recorded entries at their
            discretion in order to keep those records accurate. Their
            good-faith decisions regarding the App&apos;s records are final. This does not affect any
            right you may separately have against another individual member with respect to money
            actually owed between you off-platform.
          </p>
        ),
        free: (
          <p>
            Administrators resolve disputes about the Service&apos;s records, and may correct errors in them at their
            discretion in order to keep them accurate. Their good-faith decisions regarding the App&apos;s records are final.
          </p>
        ),
      }),
  },
  {
    id: "warranty",
    title: "No warranty",
    modes: ALL,
    body: () => (
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available,&quot; without warranties
        of any kind, whether express, implied, or statutory, including any implied warranties of
        merchantability, fitness for a particular purpose, or non-infringement. We do not warrant
        that the Service will be uninterrupted, error-free, or secure.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    modes: ALL,
    body: ({ mode }) => (
      <p>
        To the fullest extent permitted by law, the Company and its officers, employees, and
        administrators will not be liable for any indirect, incidental, special, consequential,
        or punitive damages, or any loss of money, data, or goodwill, arising from or related to
        your use of the Service
        {byMode(mode, {
          active: " — including, without limitation, any loss arising from an off-platform payment made or received between members",
          retained: " — including, without limitation, any loss arising from an off-platform payment made or received between members",
          free: "",
        })}
        . To the fullest extent permitted by
        law, the Company&apos;s total aggregate liability for any claim arising out of or relating
        to the Service will not exceed one hundred U.S. dollars (US$100).
      </p>
    ),
  },
  {
    id: "indemnity",
    title: "Indemnification",
    modes: ALL,
    body: ({ mode }) => (
      <p>
        You agree to indemnify and hold harmless the Company and its administrators from any
        claim, demand, loss, or damages, including reasonable attorneys&apos; fees, arising out of
        your use of the Service, your violation of these Terms, or your violation of any law or
        the rights of a third party
        {byMode(mode, { active: ", including any dispute over money you sent or received off-platform", retained: ", including any dispute over money you sent or received off-platform", free: "" })}.
      </p>
    ),
  },
  {
    id: "termination",
    title: "Termination",
    modes: ALL,
    body: ({ mode, ref }) => (
      <>
        <p>
          We may suspend or terminate your access to the Service at any time, with or without
          notice, for any reason, including if we believe you have violated these Terms. You may
          stop using the Service at any time.
        </p>
        {byModeLazy(mode, {
          active: () => null,
          retained: () => <p>Closing or ending an account does not erase the wallet records described in Section {ref("records")}.</p>,
          free: () => null,
        })}
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    modes: ALL,
    body: () => (
      <p>
        We may update these Terms from time to time. If we make material changes, we will make
        the updated Terms available in the App. Continued use of the Service after a change
        becomes effective constitutes acceptance of the revised Terms.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law and disputes",
    modes: ALL,
    body: () => (
      <p>
        These Terms are governed by the laws of <strong>Costa Rica</strong>,
        without regard to conflict-of-law principles. Any dispute arising out of or relating to
        these Terms or the Service will be resolved exclusively in the courts of that
        jurisdiction, and you consent to their personal jurisdiction.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    modes: ALL,
    body: () => (
      <p>
        Questions about these Terms can be sent to{" "}
        <a href="mailto:support@brohda.com" className="underline underline-offset-4">
          support@brohda.com
        </a>
        .
      </p>
    ),
  },
];

/** The section ids shown in a mode, in order — exported so tests can assert numbering and cross-references against it. */
export function termsSectionIds(mode: LegalMoneyMode): SectionId[] {
  return SECTIONS.filter((s) => s.modes.includes(mode)).map((s) => s.id);
}

export function TermsDocument({ mode }: { mode: LegalMoneyMode }) {
  const shown = SECTIONS.filter((s) => s.modes.includes(mode));
  const numbers = new Map(shown.map((s, i) => [s.id, i + 1]));
  // A reference to a hidden section is a bug, never silently rendered as a wrong number.
  const ref: Ref = (id) => {
    const n = numbers.get(id);
    if (n === undefined) throw new Error(`Terms: section "${id}" is referenced but not shown in mode "${mode}"`);
    return String(n);
  };
  return (
    <LegalPage title="Terms of Service" effectiveDate={LEGAL_DOCUMENTS.terms.effectiveDate}>
      <section>
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of brohda.
          (&quot;brohda.&quot;, the &quot;App&quot;, the &quot;Service&quot;, &quot;we&quot;, &quot;us&quot;), operated by{" "}
          <strong>brohda</strong> (the &quot;Company&quot;). By creating an account,
          accepting an invitation, or otherwise using the Service, you agree to be bound by
          these Terms. If you do not agree, do not use the Service.
        </p>
      </section>
      {shown.map((section) => (
        <section key={section.id}>
          <h2>
            {numbers.get(section.id)}. {section.title}
          </h2>
          {section.body({ mode, ref })}
        </section>
      ))}
    </LegalPage>
  );
}
