import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — brohda.",
  robots: { index: false, follow: false },
};

const EFFECTIVE_DATE = "July 22, 2026";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" effectiveDate={EFFECTIVE_DATE}>
      <section>
        <p>
          This Privacy Policy describes how <strong>[Company Legal Name]</strong> (&quot;we&quot;,
          &quot;us&quot;) handles information in connection with brohda. (the &quot;App&quot;, the
          &quot;Service&quot;), a private, invite-only platform. It applies only to information
          collected through the App itself — it does not cover the payment apps, banks, or other
          third-party services members use to move money between each other off-platform, which
          have their own privacy policies.
        </p>
      </section>

      <section>
        <h2>1. Information we collect</h2>
        <ul>
          <li>
            <strong>Account information</strong>: the email address you were invited with, your
            display name, username, and optional profile photo.
          </li>
          <li>
            <strong>Activity within the App</strong>: pools you create or join, your picks,
            comments, likes, follows, and the wallet ledger entries recorded when an administrator
            confirms an off-platform payment (amount, date, payment method you selected, and any
            reference note you provide — never a card number or bank credential, since we never
            handle the payment itself).
          </li>
          <li>
            <strong>Device and log data</strong>: basic technical information such as IP address,
            browser type, and timestamps of requests, used for security and to keep the Service
            running reliably.
          </li>
        </ul>
      </section>

      <section>
        <h2>2. What we do not collect</h2>
        <p>
          Because all real-money transfers happen directly between members using third-party
          payment services, we never receive, process, or store your bank account number, card
          number, payment app login credentials, or government identification. The &quot;destination&quot;
          details (such as a Venmo handle or wallet address) shown in the App are provided by group
          administrators to tell members where to send funds off-platform — they are not
          collected from you as sensitive account credentials.
        </p>
      </section>

      <section>
        <h2>3. How we use information</h2>
        <ul>
          <li>To operate, maintain, and secure the Service.</li>
          <li>To let you participate in pools and see the group&apos;s shared activity, leaderboard, and wallet ledger.</li>
          <li>To send you notifications about activity relevant to you (for example, a pool result or a reply to your comment).</li>
          <li>To detect and prevent fraud, abuse, or violations of our Terms of Service.</li>
          <li>To respond to support requests.</li>
        </ul>
      </section>

      <section>
        <h2>4. What other members can see</h2>
        <p>
          brohda. is a social app for a private group: your username, display name, profile photo,
          public activity (entries, likes, comments), and leaderboard stats are visible to other
          members of your group by design. Group administrators additionally see wallet requests
          you submit (amount, payment method, and any transaction reference or note) in order to
          review and confirm off-platform payments.
        </p>
      </section>

      <section>
        <h2>5. Third-party services we use</h2>
        <p>
          We use infrastructure providers to run the Service, including a hosting/database/authentication
          provider and a sports-data provider that supplies fixture and match information displayed
          in the App. These providers process data on our behalf under their own security and
          privacy commitments. We do not sell your information to anyone, and we do not share it
          with advertisers.
        </p>
      </section>

      <section>
        <h2>6. Data retention</h2>
        <p>
          We retain account and activity information for as long as your account is active, and for
          a reasonable period afterward as needed to maintain the accuracy of the group&apos;s
          historical ledger, resolve disputes, or comply with legal obligations.
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
          access to, correction of, or deletion of your information, or to close your account,
          contact a group administrator or email us at the address below.
        </p>
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
