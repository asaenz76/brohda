import type { ReactNode } from "react";
import { RefundTerms } from "@/components/legal/RefundTerms";

// The STANDING terms of the per-campaign Media and Advertising Agreement (the campaign-specific schedule — Sponsor, Game, dates, price, creative, promotion,
// payment state — is generated from the canonical sponsorship record and shown next to this text; it is never retyped here).
// DRAFT — OWNER/COUNSEL REVIEW REQUIRED: this wording was written by engineering and is not legal advice or approved text.
export const mediaAgreementSections = (cutoffHours: number | null): ReadonlyArray<{ id: string; title: string; body: ReactNode }> => [
  {
    id: "parties",
    title: "What this agreement covers",
    body: <p>One sponsorship of one Game Post by the Sponsor named in the schedule, for the dates and price in the schedule. It sits on top of the Sponsor Terms; if they conflict, this agreement controls for this campaign only.</p>,
  },
  {
    id: "approval",
    title: "Payment and approval",
    body: <p>A sponsorship runs only when it has been both paid for and approved by Brohda. Payment does not guarantee approval, and approval can be withdrawn if the approved content changes or the Sponsor account is suspended.</p>,
  },
  {
    id: "creative",
    title: "Creative and destination",
    body: <p>The Sponsor is responsible for everything it provides — name, logo, text, call-to-action, destination link and any promotion — and confirms it has the right to use it. Brohda may refuse, edit-by-request or remove content, and labels every sponsored Game Post as sponsored.</p>,
  },
  {
    id: "promotion",
    title: "Sponsor-run promotions",
    body: <p>If a promotion is attached, the Sponsor (or its named administrator) is solely responsible for its official rules, eligibility, winner selection and prize fulfillment. Brohda does not run entries, choose winners or deliver prizes, and does not guarantee a promotion is lawful in every place.</p>,
  },
  {
    id: "independence",
    title: "No influence over Brohda",
    body: <p>Sponsorship does not influence Markets, Picks, comments, grading or results, and gives the Sponsor no access to individual Members or their data.</p>,
  },
  {
    id: "suspension",
    title: "Suspension and cancellation",
    body: <p>Brohda may suspend or cancel a sponsorship, or suspend the Sponsor account, at any time. Suspension removes the sponsor presentation immediately; the Game Post itself stays. Suspension is not a refund; any refund follows the refund terms below and is decided and recorded by Brohda.</p>,
  },
  {
    id: "refunds",
    title: "Refunds",
    body: <RefundTerms cutoffHours={cutoffHours} />,
  },
  {
    id: "liability",
    title: "Liability",
    body: <p>[Limitation of liability and indemnity — wording to be provided by counsel.]</p>,
  },
];

export function MediaAgreementTerms({ cutoffHours = null }: { cutoffHours?: number | null }) {
  return (
    <ol className="space-y-4">
      {mediaAgreementSections(cutoffHours).map((s) => (
        <li key={s.id}>
          <h3 className="text-sm font-semibold text-text-primary">{s.title}</h3>
          <div className="mt-1">{s.body}</div>
        </li>
      ))}
    </ol>
  );
}
