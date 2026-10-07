import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { byMode, type LegalMoneyMode } from "@/lib/legal/money-mode";

// The Privacy Policy, composed per money mode (lib/legal/money-mode.ts). The twelve sections are the same in every mode; only the money-bearing
// passages differ, and every variant is explicit (byMode requires all three):
//
//   active    optional money is on — the complete policy.
//   retained  optional money is off but financial records still exist (or cannot be ruled out) — the CURRENT-feature explanations are gone, but the
//             disclosure of the financial data we hold stays: what the records are, who can see them, how long they are kept, how a withdrawal
//             destination is handled, and what closing an account does and does not erase. We never claim to hold no financial data on the strength
//             of a feature flag.
//   free      money is off and nothing financial was ever stored — no money language, and no claim about records that do not exist.
// Wording flagged OWNER/COUNSEL REVIEW REQUIRED in docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md is unchanged in `active`.
export function PrivacyDocument({ mode }: { mode: LegalMoneyMode }) {
  return (
    <LegalPage title="Privacy Policy" effectiveDate={LEGAL_DOCUMENTS.privacy.effectiveDate}>
      <section>
        <p>
          This Privacy Policy describes how <strong>brohda</strong> (&quot;we&quot;,
          &quot;us&quot;) handles information in connection with brohda. (the &quot;App&quot;, the
          &quot;Service&quot;), a social network around real sporting events. It applies only to
          information collected through the App itself
          {byMode(mode, {
            active: <> — it does not cover the payment apps, banks, or other third-party services members use to move money into or out of the App off-platform, which have their own privacy policies.</>,
            retained: <> — it does not cover the payment apps, banks, or other third-party services members use to move money into or out of the App off-platform, which have their own privacy policies.</>,
            free: <>.</>,
          })}
        </p>
      </section>

      <section>
        <h2>1. Information we collect</h2>
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
            retained: (
          <li>
            <strong>Wallet and money records</strong>: your wallet ledger entries, any offers and Positions you took part in
            (amounts, holds, and settlements), and the entries recorded when an administrator confirmed an off-platform
            payment (amount, date, payment method you selected, and any reference note you provide — never a card number or bank
            credential, since we never handle the payment itself). When you request a withdrawal you also enter where you want to
            be paid (for example a payment-app handle or wallet address); we store it with your request.
          </li>
            ),
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
      </section>

      <section>
        <h2>2. What we do not collect</h2>
        {byMode(mode, {
          active: (
          <p>
          Because actual money transfers into and out of the App happen through third-party payment
          services outside the App, we never receive, process, or store your bank account number, card
          number, payment app login credentials, or government identification. The &quot;destination&quot;
          details (such as a Venmo handle or wallet address) shown in the App for deposits are
          provided by administrators to tell members where to send funds off-platform. The payout
          destination you enter when you request a withdrawal is provided by you; it is visible to
          you and to the administrators who process the request, and is recorded on the resulting
          ledger entry. Neither is collected as a sensitive account credential.
        </p>
          ),
          retained: (
          <p>
          Because actual money transfers into and out of the App happen through third-party payment
          services outside the App, we never receive, process, or store your bank account number, card
          number, payment app login credentials, or government identification. The payout
          destination you enter when you request a withdrawal is provided by you; it is visible to
          you and to the administrators who process the request, and is recorded on the resulting
          ledger entry. It is not collected as a sensitive account credential.
        </p>
          ),
          free: (
          <p>
          We do not collect payment card numbers, bank account numbers, payment app login credentials, or government
          identification.
        </p>
          ),
        })}
      </section>

      <section>
        <h2>3. How we use information</h2>
        <ul>
          <li>To operate, maintain, and secure the Service.</li>
          <li>To let you make Picks, comment, challenge other members with Call BS, and see your own prediction record{byMode(mode, { active: " and wallet ledger", retained: " and wallet ledger", free: "" })}.</li>
          <li>To send you notifications about activity relevant to you (for example, a graded Pick, a Call BS result, or a reply to your comment).</li>
          <li>To detect and prevent fraud, abuse, or violations of our Terms of Service.</li>
          <li>To respond to support requests.</li>
        </ul>
      </section>

      <section>
        <h2>4. What other members can see</h2>
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
          <strong>Wallet and money records are private to the people involved.</strong> Your wallet ledger, and any offers or
          Positions you took part in, are visible to you, to the other member in a Position you shared, and to authorized
          administrators; money notifications were sent only to the two members involved. No other member can see them.
          Administrators also see wallet requests you submit (amount, payment method, and any transaction reference or note)
          in order to review and confirm off-platform payments, and the people who operate the Service&apos;s infrastructure
          can access stored data as needed to run, secure, and support the Service.
        </p>
          ),
          free: (
        <p>
          The people who operate the Service&apos;s infrastructure can access stored data as needed to run, secure, and support
          the Service.
        </p>
          ),
        })}
      </section>

      <section>
        <h2>5. Third-party services we use</h2>
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
      </section>

      <section>
        <h2>6. Data retention</h2>
        <p>
          We retain account and activity information for as long as your account is active, and for
          a reasonable period afterward as needed to maintain the accuracy of the Service&apos;s
          historical {byMode(mode, { active: "ledger", retained: "ledger", free: "records" })}, resolve disputes, or comply with legal obligations.{byMode(mode, {
            active: " Wallet and money-Position records are kept as permanent records of the Service's ledger.",
            retained: " Wallet and money-Position records are kept as permanent records of the Service's ledger.",
            free: "",
          })}
        </p>
      </section>

      <section>
        <h2>7. Security</h2>
        <p>
          We use reasonable technical and organizational measures designed to protect information
          in the App. No method of transmission or storage is completely secure, and we cannot
          guarantee absolute security.
        </p>
      </section>

      <section>
        <h2>8. Children&apos;s privacy</h2>
        <p>
          The Service is not directed to, and is not intended for use by, anyone under 18 years of
          age (or the age of legal majority in their jurisdiction). We do not knowingly collect
          information from children.
        </p>
      </section>

      <section>
        <h2>9. Your choices</h2>
        <p>
          You can review and update your profile information in the App at any time. To request
          access to or correction of your information, contact an administrator or email us at the
          address below.
        </p>
        {byMode(mode, {
          active: (
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
          retained: (
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
          free: (
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
      </section>

      <section>
        <h2>10. Cookies and similar technology</h2>
        <p>
          We use essential cookies/session tokens solely to keep you signed in and to secure your
          session. We do not use advertising or cross-site tracking cookies.
        </p>
      </section>

      <section>
        <h2>11. Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. If we make material changes, we will
          make the updated policy available in the App.
        </p>
      </section>

      <section>
        <h2>12. Contact</h2>
        <p>
          Questions about this Privacy Policy can be sent to{" "}
          <a href="mailto:support@brohda.com" className="underline underline-offset-4">
            support@brohda.com
          </a>
          .
        </p>
      </section>
    </LegalPage>
  );
}
