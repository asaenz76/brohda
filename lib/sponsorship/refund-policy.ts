import type { SponsorshipLifecycle, SponsorshipPaymentStatus, SponsorshipReviewStatus } from "./types";

// THE Sponsor refund policy: one place, readable by people and by code. Payment is manual and provider-neutral, so a refund is an EXPLICIT, audited Super
// Admin action (Mark refund pending / Mark refunded) — nothing here, and nothing anywhere, ever refunds automatically, and suspending a campaign or a
// Sponsor account never changes the payment state.
//
// STATUS: PROPOSED — OWNER DECISION REQUIRED. The "proposed" treatment of each case below is engineering's recommended default, written so Super Admin has
// a rule to follow instead of an undefined judgment call; it is NOT approved. The owner chooses among `options` (and counsel words the legal text) before
// it is relied on as policy. Changing a treatment is changing this file — there are deliberately no hidden numbers or thresholds.
export const REFUND_POLICY_STATUS = "PROPOSED — OWNER DECISION REQUIRED" as const;

export type RefundCaseId = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export interface RefundCase {
  id: RefundCaseId;
  title: string;
  /** Engineering's recommended default (NOT approved). */
  proposed: string;
  /** The owner's real choices. */
  options: readonly string[];
}

export const REFUND_CASES: Readonly<Record<RefundCaseId, RefundCase>> = {
  A: { id: "A", title: "The Sponsor paid, then Brohda rejected the campaign", proposed: "Full refund — nothing was delivered.", options: ["Full refund", "Credit toward another Game instead, if the Sponsor prefers"] },
  B: { id: "B", title: "The Sponsor cancels before approval", proposed: "Full refund.", options: ["Full refund", "Full refund less documented administrative cost"] },
  C: { id: "C", title: "The Sponsor cancels after approval but before the campaign starts", proposed: "Full refund.", options: ["Full refund", "Full refund less documented administrative cost", "Credit toward another Game", "No refund inside a notice period the owner names"] },
  D: { id: "D", title: "Brohda suspends or cancels the campaign before it starts", proposed: "Full refund (or a replacement Game, at the Sponsor's choice).", options: ["Full refund", "Replacement Game at the Sponsor's choice"] },
  E: { id: "E", title: "The campaign has started and then the campaign or the Sponsor account is suspended", proposed: "No refund when the suspension is for the Sponsor's breach; a prorated refund for the undelivered time when it is for Brohda's reasons. Super Admin records which.", options: ["No refund for breach / prorated otherwise", "Always prorated", "Never refunded once started"] },
  F: { id: "F", title: "The Game is cancelled, postponed or otherwise cannot deliver the agreed sponsorship", proposed: "Sponsor's choice of a full refund or a replacement Game.", options: ["Full refund", "Replacement Game", "Sponsor's choice"] },
  G: { id: "G", title: "The sponsorship has already completed", proposed: "No refund — it was delivered — unless Brohda failed to deliver what was agreed.", options: ["No refund", "Case-by-case for a delivery failure"] },
};

/** Fixture statuses under which a Game cannot deliver the sponsorship as agreed. */
const UNDELIVERABLE_FIXTURE = new Set(["CANCELLED", "POSTPONED", "ABANDONED", "SUSPENDED"]);

export interface RefundContext {
  lifecycle: SponsorshipLifecycle;
  reviewStatus: SponsorshipReviewStatus;
  paymentStatus: SponsorshipPaymentStatus;
  startsAt: string;
  fixtureStatus: string | null;
}

/**
 * The refund cases that may apply to this campaign right now — guidance for Super Admin, shown beside the refund actions. It never refunds anything. Empty
 * when no money was received (nothing to refund).
 */
export function candidateRefundCases(s: RefundContext, now: Date = new Date()): RefundCaseId[] {
  const moneyReceived = s.paymentStatus === "PAID" || s.paymentStatus === "REFUND_PENDING" || s.paymentStatus === "REFUNDED";
  if (!moneyReceived) return [];
  const out = new Set<RefundCaseId>();
  const started = new Date(s.startsAt).getTime() <= now.getTime();
  if (s.fixtureStatus && UNDELIVERABLE_FIXTURE.has(s.fixtureStatus)) out.add("F");
  if (s.lifecycle === "REJECTED") out.add("A");
  if (s.lifecycle === "COMPLETED") out.add("G");
  if (s.lifecycle === "SUBMITTED" || s.lifecycle === "SCHEDULED" || s.lifecycle === "CANCELLED") {
    if (s.reviewStatus !== "APPROVED") out.add("B");
    else if (!started) {
      out.add("C");
      out.add("D");
    }
  }
  if (s.lifecycle === "SUSPENDED") out.add(started ? "E" : "D");
  if (s.lifecycle === "LIVE") out.add("E");
  return [...out];
}
