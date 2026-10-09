import type { ReactNode } from "react";
import { LegalPage } from "@/components/legal/LegalPage";
import { DraftBanner } from "@/components/legal/DraftBanner";
import { MediaAgreementTerms } from "@/components/legal/MediaAgreementTerms";
import { MEDIA_AGREEMENT_DOCUMENT, SPONSOR_TERMS_DOCUMENT } from "@/lib/sponsor/terms";

// The Sponsor Terms — a document SEPARATE from the Member Terms (components/legal/TermsDocument.tsx), covering the commercial relationship between Brohda
// and a Sponsor. DRAFT — OWNER/COUNSEL REVIEW REQUIRED (see lib/sponsor/terms.ts): written by engineering to describe how sponsorships actually operate;
// the sections marked "[counsel]" are intentionally left as placeholders, not invented.
const SECTIONS: ReadonlyArray<{ id: string; title: string; body: ReactNode }> = [
  { id: "account", title: "Sponsor account and eligibility", body: <p>A Sponsor account is for a business. It is separate from a Member account and cannot be used to take part in Brohda as a Member; the same email cannot hold both. You confirm you are authorized to act for the business you name.</p> },
  { id: "review", title: "Account review and approval", body: <p>Every new Sponsor account is reviewed by Brohda before it can browse available Games or submit a sponsorship. Brohda may approve, decline, suspend or disable a Sponsor account at its discretion, and gives a reason where it can. Approving an account is separate from approving any single sponsorship.</p> },
  { id: "inventory", title: "Available Games and pricing", body: <p>Brohda decides which Games are available to sponsor and sets the price of each; Sponsors cannot set or change a price. A price is fixed for a sponsorship when it is submitted. Brohda may withdraw a Game from availability before it is sponsored.</p> },
  { id: "payment", title: "Payment", body: <p>Payment is arranged and confirmed outside the App and recorded by a Brohda administrator. A sponsorship cannot run until payment has been recorded as received. Taxes, bank charges and similar costs are the Sponsor&apos;s unless Brohda says otherwise in writing. [counsel — payment terms]</p> },
  { id: "approval", title: "Brohda's approval discretion", body: <p>A sponsorship runs only when it is both paid and approved by Brohda. Paying does not guarantee approval. Brohda may approve, request changes to, or reject any sponsorship, and approval is void if the approved content is later changed.</p> },
  { id: "scheduling", title: "Scheduling", body: <p>An approved, paid sponsorship is shown during its scheduled window and ends by itself. Brohda does not guarantee any level of visibility, clicks or results.</p> },
  { id: "suspension", title: "Suspension and cancellation of a campaign", body: <p>Brohda may suspend or cancel a sponsorship at any time. A Sponsor may cancel a sponsorship that has not been paid; once paid, cancellation is handled by Brohda under the refund terms. Suspending a campaign does not by itself refund it.</p> },
  { id: "content", title: "Your content and destination links", body: <p>You are responsible for the name, logo, text, call-to-action and destination link you provide, and for the pages they lead to. You confirm you have the rights to use them and authorize Brohda to display them as part of the sponsorship. Sponsored Game Posts are always labeled as sponsored.</p> },
  { id: "promotions", title: "Sponsor-run promotions", body: <p>If you attach a promotion, you (or the administrator you name) are solely responsible for its official rules, eligibility, winner selection and prize fulfillment, and for complying with the laws that apply to it. Brohda only displays the approved details and a link to your rules; it does not run entries, choose winners or deliver prizes, and does not guarantee your promotion is lawful anywhere.</p> },
  { id: "prohibited", title: "Prohibited content and conduct", body: <p>No unlawful, misleading, infringing, harassing or deceptive content; nothing that impersonates Brohda or a Member; no content about gambling, sports betting or odds; no attempt to influence Markets, Picks, comments, grading or results; no attempt to contact or collect data about individual Members. [counsel — complete list]</p> },
  { id: "ip", title: "Intellectual property", body: <p>You keep ownership of your materials and authorize Brohda to reproduce and display them for the sponsorship. Brohda keeps ownership of the App and its content.</p> },
  { id: "independence", title: "No control over Brohda", body: <p>A sponsorship gives you a labeled presence around a Game Post. It does not give you any control over Brohda&apos;s sports data, Markets, Picks, grading, comments, editorial choices or product.</p> },
  { id: "data", title: "Member data", body: <p>Sponsors do not receive information about individual Members. Any reporting Brohda offers in the future will be aggregate only.</p> },
  { id: "refunds", title: "Refunds", body: <p>Refunds are decided by Brohda under its refund policy, case by case, and are never automatic. Suspending a campaign or a Sponsor account is not a refund. [counsel/owner — refund policy to be approved; see the media and advertising agreement]</p> },
  { id: "termination", title: "Termination", body: <p>Brohda may suspend or disable a Sponsor account at any time. You may stop using the account at any time. Provisions that by nature should survive (payment, content responsibility, refunds, liability) survive.</p> },
  { id: "liability", title: "Limitation of liability and indemnity", body: <p>[counsel — limitation of liability, disclaimers and indemnification to be provided]</p> },
  { id: "changes", title: "Changes to these terms", body: <p>Brohda may publish a new version. When a new version is required, you will be asked to accept it before you continue; earlier acceptances stay on record.</p> },
];

export function SponsorTermsDocument({ accountNav, accept }: { accountNav?: ReactNode; accept?: ReactNode }) {
  const doc = SPONSOR_TERMS_DOCUMENT;
  return (
    <LegalPage
      title={doc.title}
      effectiveDate={doc.effectiveDate ?? "— (draft, not yet in effect)"}
      accountNav={accountNav}
      banner={doc.status === "DRAFT" ? <DraftBanner what="document" /> : null}
    >
      <p className="text-text-muted">Version {doc.version}</p>
      {SECTIONS.map((s, i) => (
        <section key={s.id}>
          <h2>
            {i + 1}. {s.title}
          </h2>
          {s.body}
        </section>
      ))}
      <section id="media-agreement">
        <h2>Media and Advertising Agreement (per campaign)</h2>
        <p>
          Each sponsorship also has its own agreement: the campaign schedule generated from the sponsorship record (Sponsor, Game, dates, price, approved content, any promotion
          and payment status) together with these standing terms. Version {MEDIA_AGREEMENT_DOCUMENT.version}
          {MEDIA_AGREEMENT_DOCUMENT.status === "DRAFT" ? " (DRAFT)" : ""}.
        </p>
        <MediaAgreementTerms />
      </section>
      {accept}
    </LegalPage>
  );
}
