import type { ReactNode } from "react";
import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { byMode, byModeLazy, type LegalMoneyMode } from "@/lib/legal/money-mode";

// The Privacy Policy, composed per money mode (lib/legal/money-mode.ts), at SECTION level like the Terms:
//
//   active    optional money is on — the complete policy.
//   retained  optional money is off but financial records still exist (or cannot be ruled out). Every current-feature explanation is gone, and so is
//             every other mention of money outside ONE clearly headed section — "Financial records we still hold" — which carries all of the disclosure
//             those records require (what is held, who can see it, how a withdrawal destination is handled, retention, what closing an account does).
//             Nothing else in the document refers to wallets, offers, Positions or payments, and nothing in that section reads as a feature a member can
//             use today: it describes records and an existing balance, in the past tense of history. We never claim to hold no financial data.
//   free      money is off and nothing financial was ever stored — no money language, and no claim about records that do not exist.
//
// Sections are numbered from the ones actually shown (the retained-only section shifts the later numbers), and every "Section N" is derived, never typed.
// Wording flagged OWNER/COUNSEL REVIEW REQUIRED in docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md is unchanged in `active`.

type SectionId = "collect" | "nocollect" | "use" | "visible" | "records" | "sponsors" | "providers" | "retention" | "security" | "children" | "choices" | "cookies" | "changes" | "contact";
type Ref = (id: SectionId) => string;

interface SectionDef {
  id: SectionId;
  title: string;
  modes: readonly LegalMoneyMode[];
  body: (ctx: { mode: LegalMoneyMode; ref: Ref }) => ReactNode;
}

const ALL: readonly LegalMoneyMode[] = ["active", "retained", "free"];

const SECTIONS: readonly SectionDef[] = [
  {
    id: "collect",
    title: "Information we collect",
    modes: ALL,
    body: ({ mode }) => (
      <ul>
        <li>
          <strong>Account information</strong>: the email address you registered or were invited
          with, your display name, username, and optional profile photo. You may also add pronouns,
          a gender, and a short bio to your profile; each is optional and has its own switch to show
          or hide it on your profile.
        </li>
        <li>
          <strong>Activity within the App</strong>: your Picks (including any changes you make to
          them before they lock), comments, Call BS challenges, the sports, leagues, and teams
          you follow, the people you follow, and the notifications we send you.
        </li>
        {byMode(mode, {
          active: (
            <li>
              <strong>Wallet and money records</strong>: where optional money Positions are or have
              been enabled, your wallet ledger entries, any offers and Positions you take part in
              (amounts, holds, and settlements), and the entries recorded when an administrator
              confirms an off-platform payment (amount, date, payment method you selected, and any
              reference note you provide — never a card number or bank credential, since we never
              handle the payment itself). When you request a withdrawal you also enter where you want to
              be paid (for example a payment-app handle or wallet address); we store it with your request.
            </li>
          ),
          retained: null,
          free: null,
        })}
        <li>
          <strong>Administrative and security records</strong>: records of actions taken by
          administrators, and security-related records such as sign-in attempts.
        </li>
        <li>
          <strong>Device and log data</strong>: basic technical information such as IP address,
          browser type, and timestamps of requests, which our hosting and infrastructure providers
          log when you use the Service, used for security and to keep the Service running reliably.
        </li>
      </ul>
    ),
  },
  {
    id: "nocollect",
    title: "What we do not collect",
    modes: ALL,
    body: ({ mode }) =>
      byMode(mode, {
        active: (
          <p>
            Because actual money transfers into and out of the App happen through third-party payment
            services outside the App, we never receive, process, or store your bank account number, card
            number, payment app login credentials, or government identification. The &quot;destination&quot;
            details (such as a payment-app handle or wallet address) shown in the App for deposits are
            provided by administrators to tell members where to send funds off-platform. The payout
            destination you enter when you request a withdrawal is provided by you; it is visible to
            you and to the administrators who process the request, and is recorded on the resulting
            ledger entry. Neither is collected as a sensitive account credential.
          </p>
        ),
        retained: (
          <p>
            We do not collect payment card numbers, bank account numbers, payment app login credentials, or government
            identification.
          </p>
        ),
        free: (
          <p>
            We do not collect payment card numbers, bank account numbers, payment app login credentials, or government
            identification.
          </p>
        ),
      }),
  },
  {
    id: "use",
    title: "How we use information",
    modes: ALL,
    body: ({ mode }) => (
      <ul>
        <li>To operate, maintain, and secure the Service.</li>
        <li>To let you make Picks, comment, challenge other members with Call BS, and see your own prediction record{byMode(mode, { active: " and wallet ledger", retained: "", free: "" })}.</li>
        <li>To send you notifications about activity relevant to you (for example, a graded Pick, a Call BS result, or a reply to your comment).</li>
        <li>To detect and prevent fraud, abuse, or violations of our Terms of Service.</li>
        <li>To respond to support requests.</li>
      </ul>
    ),
  },
  {
    id: "visible",
    title: "What other members can see",
    modes: ALL,
    body: ({ mode }) => (
      <>
        <p>
          brohda. is a social app. Other signed-in members can see your username, display name,
          profile photo, any optional profile details you choose to show, your comments, who you
          follow and who follows you, your prediction record (the share of your decided Picks that
          were correct, and how many you have made), your Call BS record and recent Call BS
          results, and your graded Picks. Members who have picked on the same Game can also see
          your Pick on that Game. People who are not signed in see only aggregate information on
          the public pages, such as how Picks split on a Game and comment counts — never an
          individual member, comment, or Pick.
        </p>
        {byMode(mode, {
          active: (
            <p>
              <strong>Money is private to the people involved.</strong> Where optional money Positions
              are or have been enabled, an offer or Position between two members — whether it exists,
              its amount and status, its settlement, and its effect on either wallet — is visible to
              those two members and to authorized administrators, and money notifications are sent
              only to the two members involved. No other member can see it. Administrators also see
              wallet requests you submit (amount, payment method, and any transaction reference or
              note) in order to review and confirm off-platform payments, and the people who operate
              the Service&apos;s infrastructure can access stored data as needed to run, secure, and
              support the Service.
            </p>
          ),
          retained: (
            <p>
              The people who operate the Service&apos;s infrastructure can access stored data as needed to run, secure, and support
              the Service.
            </p>
          ),
          free: (
            <p>
              The people who operate the Service&apos;s infrastructure can access stored data as needed to run, secure, and support
              the Service.
            </p>
          ),
        })}
      </>
    ),
  },
  {
    id: "records",
    title: "Financial records we still hold",
    modes: ["retained"],
    body: ({ ref }) => (
      <>
        <p>
          The Service keeps wallet and money records from earlier activity: your wallet ledger entries, any offers and Positions you
          took part in (amounts, holds, and settlements), and the entries recorded when an administrator confirmed an off-platform
          payment (amount, date, payment method you selected, and any reference note you provided — never a card number or bank
          credential, since we never handle the payment itself). If you request a withdrawal of an existing balance, you also enter
          where you want to be paid (for example a payment-app handle or wallet address); we store it with your request. It is
          provided by you, is visible to you and to the administrators who process the request, is recorded on the resulting ledger
          entry, and is not collected as a sensitive account credential.
        </p>
        <p>
          <strong>Who can see these records.</strong> Your wallet ledger, and any past offers or Positions you took part in, are
          visible to you, to the other member in a Position you shared, and to authorized administrators. No other member can see
          them. Administrators also see the wallet requests you submit (amount, payment method, and any transaction reference or
          note) in order to review and confirm payments.
        </p>
        <p>
          <strong>How long we keep them.</strong> Wallet and money-Position records are kept as permanent records of the
          Service&apos;s ledger. You can close your account once your wallet balance is zero and you have no pending wallet requests;
          closing an account does not erase these records (see Section {ref("choices")}).
        </p>
      </>
    ),
  },
  {
    id: "sponsors",
    title: "Sponsor accounts and sponsorships",
    modes: ALL,
    body: () => (
      <>
        <p>
          <strong>DRAFT — pending owner and counsel review.</strong> This section describes how we handle information about businesses that
          apply for, or hold, a Sponsor account. A Sponsor account is separate from a Member account: it has no Member profile and cannot
          make Picks, comment, Call BS, or use any other Member feature.
        </p>
        <p>
          <strong>What we collect from Sponsors.</strong> The business email used to sign in; a password (handled by our authentication
          provider, not stored in readable form by us); the brand or company name; the contact person&apos;s name; and, if you choose to give
          them, a website, country, phone or WhatsApp number, and a logo. We also keep the status of the application and account (pending,
          approved, not approved, suspended or disabled), the reason given for a decision, the time of each decision, and internal review
          notes. For each sponsorship we keep the Game it is attached to, the campaign name, the text and links you provide, any sponsor-run
          promotion details, the agreed price and schedule, the commercial records an administrator enters (such as a payment reference or a
          refund record), a record of the Sponsor terms you accept (which version, and when), and an audit trail of who did what and when.
          We do not collect card or bank credentials: sponsorship payments are arranged and confirmed outside the App and recorded by an
          administrator.
        </p>
        <p>
          <strong>What is public and what is private.</strong> Your brand name and logo, and the approved campaign text, call-to-action,
          destination link and any approved promotion details, are shown to Members on the sponsored Game Post, clearly labeled as sponsored.
          Your website and country are not shown publicly unless they are part of that approved campaign content. Your sign-in email, the
          contact person&apos;s name, phone number, internal review notes, commercial records and audit records are not public: they are visible
          only to you (your own) and to authorized administrators.
        </p>
        <p>
          <strong>Measurement.</strong> For each sponsored placement we count when a signed-in Member has seen it and when a Member follows its
          link. These are counts attached to the campaign and are used internally to operate and review sponsorships. Sponsors do not
          currently receive a reporting dashboard, and Sponsors never receive information about individual Members.
        </p>
        <p>
          Following a sponsor&apos;s link leaves the App; the sponsor&apos;s own privacy practices apply from there. To ask about the information
          we hold for a Sponsor account, contact us at{" "}
          <a href="mailto:support@brohda.com" className="underline underline-offset-4">
            support@brohda.com
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "providers",
    title: "Third-party services we use",
    modes: ALL,
    body: () => (
      <>
        <p>
          We use providers to run the Service: Vercel (hosting), Supabase (database, sign-in, and
          file storage), API-Sports (the sports data for NFL, NBA, and NHL games that supplies fixture and match
          information displayed in the App), Sentry (error and performance monitoring), and Resend (email
          delivery). These providers process data on our behalf under their own security and privacy
          commitments. We do not sell your information to anyone, and we do not share it with
          advertisers.
        </p>
        <p>
          <strong>Error monitoring.</strong> When something goes wrong, or for a sample of page loads,
          diagnostic information is sent to our error-monitoring provider: for example the page
          address, browser and device type, timing, and the technical details of the error. We do not
          configure it to attach your name, email address, or account identifier, and it does not
          record your session, but an error message or page address can incidentally include
          identifiers.
        </p>
        <p>
          <strong>Email.</strong> Account emails, such as password-reset messages, are sent through our
          email provider, which receives your email address and the content of the message. Service
          administrators may also send occasional service notices by email.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "Data retention",
    modes: ALL,
    body: ({ mode }) => (
      <p>
        We retain account and activity information for as long as your account is active, and for
        a reasonable period afterward as needed to maintain the accuracy of the Service&apos;s
        historical {byMode(mode, { active: "ledger", retained: "records", free: "records" })}, resolve disputes, or comply with legal obligations.{byMode(mode, {
          active: " Wallet and money-Position records are kept as permanent records of the Service's ledger.",
          retained: "",
          free: "",
        })}
      </p>
    ),
  },
  {
    id: "security",
    title: "Security",
    modes: ALL,
    body: () => (
      <p>
        We use reasonable technical and organizational measures designed to protect information
        in the App. No method of transmission or storage is completely secure, and we cannot
        guarantee absolute security.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children's privacy",
    modes: ALL,
    body: () => (
      <p>
        The Service is not directed to, and is not intended for use by, anyone under 18 years of
        age (or the age of legal majority in their jurisdiction). We do not knowingly collect
        information from children.
      </p>
    ),
  },
  {
    id: "choices",
    title: "Your choices",
    modes: ALL,
    body: ({ mode, ref }) => (
      <>
        <p>
          You can review and update your profile information in the App at any time. To request
          access to or correction of your information, contact an administrator or email us at the
          address below.
        </p>
        {byModeLazy(mode, {
          active: () => (
            <p>
              <strong>Closing your account.</strong> You can close your account from your profile
              settings once your wallet balance is zero and you have no pending wallet requests. Closing
              deactivates the account and permanently removes your name, username, photo, and optional
              profile details from your profile; your email address stays reserved and cannot be used to
              register again. Some records are kept rather than erased because they are part of the
              Service&apos;s history: your Picks and comments (shown as &quot;Deleted User&quot;), Call BS
              results, the wallet and money ledger, records of administrator actions (which may keep the
              name and username the account had before it was closed), and the record of which versions
              of the Terms and Privacy Policy you accepted.
            </p>
          ),
          retained: () => (
            <p>
              <strong>Closing your account.</strong> You can close your account from your profile settings. Closing deactivates the
              account and permanently removes your name, username, photo, and optional profile details from your profile; your email
              address stays reserved and cannot be used to register again. Some records are kept rather than erased because they are
              part of the Service&apos;s history: your Picks and comments (shown as &quot;Deleted User&quot;), Call BS results,
              records of administrator actions (which may keep the name and username the account had before it was closed), the
              record of which versions of the Terms and Privacy Policy you accepted, and the financial records described in Section{" "}
              {ref("records")}.
            </p>
          ),
          free: () => (
            <p>
              <strong>Closing your account.</strong> You can close your account from your profile settings. Closing deactivates the
              account and permanently removes your name, username, photo, and optional profile details from your profile; your email
              address stays reserved and cannot be used to register again. Some records are kept rather than erased because they are
              part of the Service&apos;s history: your Picks and comments (shown as &quot;Deleted User&quot;), Call BS results, records
              of administrator actions (which may keep the name and username the account had before it was closed), and the record of
              which versions of the Terms and Privacy Policy you accepted.
            </p>
          ),
        })}
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and similar technology",
    modes: ALL,
    body: () => (
      <p>
        We use essential cookies/session tokens solely to keep you signed in and to secure your
        session. We do not use advertising or cross-site tracking cookies.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    modes: ALL,
    body: () => (
      <p>
        We may update this Privacy Policy from time to time. If we make material changes, we will
        make the updated policy available in the App.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    modes: ALL,
    body: () => (
      <p>
        Questions about this Privacy Policy can be sent to{" "}
        <a href="mailto:support@brohda.com" className="underline underline-offset-4">
          support@brohda.com
        </a>
        .
      </p>
    ),
  },
];

/** The section ids shown in a mode, in order — exported so tests can assert numbering and cross-references against it. */
export function privacySectionIds(mode: LegalMoneyMode): SectionId[] {
  return SECTIONS.filter((s) => s.modes.includes(mode)).map((s) => s.id);
}

export function PrivacyDocument({ mode, accountNav }: { mode: LegalMoneyMode; accountNav?: ReactNode }) {
  const shown = SECTIONS.filter((s) => s.modes.includes(mode));
  const numbers = new Map(shown.map((s, i) => [s.id, i + 1]));
  // A reference to a hidden section is a bug, never silently rendered as a wrong number.
  const ref: Ref = (id) => {
    const n = numbers.get(id);
    if (n === undefined) throw new Error(`Privacy: section "${id}" is referenced but not shown in mode "${mode}"`);
    return String(n);
  };
  return (
    <LegalPage title="Privacy Policy" effectiveDate={LEGAL_DOCUMENTS.privacy.effectiveDate} accountNav={accountNav}>
      <section>
        <p>
          This Privacy Policy describes how <strong>brohda</strong> (&quot;we&quot;,
          &quot;us&quot;) handles information in connection with brohda. (the &quot;App&quot;, the
          &quot;Service&quot;), a social network around real sporting events. It applies only to
          information collected through the App itself
          {byMode(mode, {
            active: <> — it does not cover the payment apps, banks, or other third-party services members use to move money into or out of the App off-platform, which have their own privacy policies.</>,
            retained: <> — it does not cover the third-party services you use outside the App, which have their own privacy policies.</>,
            free: <>.</>,
          })}
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
