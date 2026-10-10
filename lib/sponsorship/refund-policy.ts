import type { SponsorshipLifecycle, SponsorshipPaymentStatus, SponsorshipReviewStatus } from "./types";

// THE Sponsor refund policy, V1 (owner-decided). Two halves, each with exactly one home:
//
//   * the DECISION — "is this refund-eligible?" — is the database function public.sponsorship_refund_evaluation(): it reads the canonical Game start time and
//     the single configurable cutoff (platform_settings.sponsorship_refund_cutoff_hours) and nothing else decides it. Server code asks it through
//     evaluateSponsorshipRefundEligibility() (lib/sponsorship/refund-evaluation.ts).
//   * the WORDING and the case map — this file: the plain-language rules, the copy shown to Sponsors and Super Admin, and which cause applies to which
//     campaign state. It contains no cutoff number: every hour count shown comes from the evaluation (i.e. from the setting).
//
// ELIGIBLE IS NOT REFUNDED. A refund is only ever an explicit, audited Super Admin action (Mark refund pending / Mark refunded), provider-neutral; suspending a
// campaign or a Sponsor account never refunds anything. Releasing the inventory slot after a cancellation is independent of refund eligibility.
export const REFUND_POLICY_VERSION = "V1";

export type RefundCaseId = "A" | "B" | "C" | "D" | "E" | "F" | "G";

/** The causes the database function understands. */
export type RefundReason =
  | "SPONSOR_CANCELLATION"
  | "BROHDA_REJECTED"
  | "BROHDA_CANCELLED_NO_BREACH"
  | "GAME_UNDELIVERABLE"
  | "SPONSOR_BREACH"
  | "BROHDA_LIVE_INTERRUPTION"
  | "COMPLETED_DELIVERED"
  | "BROHDA_NON_DELIVERY";

/** The causes Super Admin can state when Brohda cancels (the Sponsor's own cancellation is a different path and needs no cause). */
export const ADMIN_CANCEL_CAUSES = ["BROHDA_CANCELLED_NO_BREACH", "SPONSOR_BREACH", "GAME_UNDELIVERABLE", "BROHDA_NON_DELIVERY"] as const satisfies readonly RefundReason[];
export type AdminCancelCause = (typeof ADMIN_CANCEL_CAUSES)[number];

export const ADMIN_CANCEL_CAUSE_LABEL: Record<AdminCancelCause, string> = {
  BROHDA_CANCELLED_NO_BREACH: "Brohda's decision (not the Sponsor's breach)",
  SPONSOR_BREACH: "Sponsor breach / prohibited content",
  GAME_UNDELIVERABLE: "The Game cannot deliver (cancelled / postponed)",
  BROHDA_NON_DELIVERY: "Brohda failed to deliver",
};

export interface RefundEvaluation {
  eligible: boolean;
  reasonCode: string;
  reason: RefundReason;
  moneyReceived: boolean;
  kickoffAt: string;
  cutoffHours: number;
  cutoffAt: string;
  evaluatedAt: string;
  /** Super Admin must choose among `options` (refund vs replacement, etc.) — the system never chooses for the Sponsor. */
  requiresChoice: boolean;
  options: string[];
}

export interface RefundCase {
  id: RefundCaseId;
  title: string;
  rule: (cutoffHours: number) => string;
  reasons: readonly RefundReason[];
}

const hoursLabel = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;

export const REFUND_CASES: Readonly<Record<RefundCaseId, RefundCase>> = {
  A: { id: "A", title: "The Sponsor paid and Brohda rejected the sponsorship", reasons: ["BROHDA_REJECTED"], rule: () => "Full refund eligible. The Sponsor does not bear the cost of inventory Brohda refuses to approve; the cancellation cutoff does not apply." },
  B: { id: "B", title: "The Sponsor cancels before the campaign is approved", reasons: ["SPONSOR_CANCELLATION"], rule: (h) => `Full refund eligible if the cancellation is completed at least ${hoursLabel(h)} before the Game's scheduled start; not refundable after that. Approval status does not change this.` },
  C: { id: "C", title: "The Sponsor cancels after approval but before the campaign starts", reasons: ["SPONSOR_CANCELLATION"], rule: (h) => `The same rule: full refund eligible at least ${hoursLabel(h)} before the Game's scheduled start; not refundable after that.` },
  D: { id: "D", title: "Brohda cancels or suspends before delivery, for a reason that is not the Sponsor's breach", reasons: ["BROHDA_CANCELLED_NO_BREACH"], rule: () => "The Sponsor may choose a full refund or replacement sponsorship inventory agreed with Brohda. The Sponsor's cancellation cutoff does not apply." },
  E: { id: "E", title: "The campaign is suspended after going live", reasons: ["SPONSOR_BREACH", "BROHDA_LIVE_INTERRUPTION"], rule: () => "If the cause is the Sponsor's breach, prohibited content, material misrepresentation or another Sponsor-caused reason: no automatic refund. If Brohda suspends or ends it for a Brohda-caused reason: the undelivered portion is refund eligible. The method for working out the undelivered portion is an OWNER DECISION still pending; until then Super Admin determines it and records the basis." },
  F: { id: "F", title: "The Game is cancelled, postponed or cannot deliver the sponsorship", reasons: ["GAME_UNDELIVERABLE"], rule: () => "The Sponsor may choose a full refund or a replacement Game. A merely postponed Game is never decided silently: Super Admin offers to preserve/reschedule, replace, or refund. The Sponsor's cancellation cutoff does not apply when Brohda cannot deliver." },
  G: { id: "G", title: "The campaign has completed", reasons: ["COMPLETED_DELIVERED", "BROHDA_NON_DELIVERY"], rule: () => "No refund once delivered through its window, unless Brohda materially failed to deliver. Low engagement is not non-delivery: Brohda sells media presence, not impressions, clicks, Picks, comments, conversions or sales." },
};

/** "Refunds for Sponsor-initiated cancellations are available only when …" — the sentence a Sponsor sees before cancelling. The hour count is the configured one. */
export function refundCutoffRuleCopy(cutoffHours: number): string {
  return `Refunds for Sponsor-initiated cancellations are available only when the Sponsorship is cancelled at least ${hoursLabel(cutoffHours)} before scheduled Game kickoff.`;
}

/** What cancelling means for THIS Sponsor right now, in plain words (no pressure, no surprise). */
export function sponsorCancellationConsequence(e: RefundEvaluation): { headline: string; detail: string; refundEligible: boolean } {
  if (!e.moneyReceived) return { headline: "No payment has been received for this sponsorship, so there is nothing to refund.", detail: "Cancelling releases the Game for another Sponsor.", refundEligible: false };
  if (e.eligible) return { headline: "This cancellation is currently refund-eligible.", detail: "Eligible does not mean automatic: Brohda records and processes the refund separately. Cancelling releases the Game for another Sponsor.", refundEligible: true };
  return { headline: "This cancellation is not eligible for a refund.", detail: `The refund cancellation deadline has passed. You can still cancel, which releases the Game for another Sponsor, but the payment is non-refundable.`, refundEligible: false };
}

export interface RefundContext {
  lifecycle: SponsorshipLifecycle;
  reviewStatus: SponsorshipReviewStatus;
  paymentStatus: SponsorshipPaymentStatus;
  startsAt: string;
  fixtureStatus: string | null;
}

/** Fixture statuses under which a Game cannot deliver the sponsorship as agreed. */
const UNDELIVERABLE_FIXTURE = new Set(["CANCELLED", "POSTPONED", "ABANDONED", "SUSPENDED"]);

/**
 * The cause(s) that may apply to this campaign right now — which evaluations Super Admin should see beside the refund actions. It decides nothing and
 * refunds nothing. Empty when no money was received.
 */
export function applicableRefundReasons(s: RefundContext, now: Date = new Date()): RefundReason[] {
  const moneyReceived = s.paymentStatus === "PAID" || s.paymentStatus === "REFUND_PENDING" || s.paymentStatus === "REFUNDED";
  if (!moneyReceived) return [];
  const out = new Set<RefundReason>();
  const started = new Date(s.startsAt).getTime() <= now.getTime();
  if (s.fixtureStatus && UNDELIVERABLE_FIXTURE.has(s.fixtureStatus)) out.add("GAME_UNDELIVERABLE");
  if (s.lifecycle === "REJECTED") out.add("BROHDA_REJECTED");
  if (s.lifecycle === "COMPLETED") {
    out.add("COMPLETED_DELIVERED");
    out.add("BROHDA_NON_DELIVERY");
  }
  if (s.lifecycle === "SUBMITTED" || s.lifecycle === "SCHEDULED") {
    out.add("SPONSOR_CANCELLATION");
    if (s.reviewStatus === "APPROVED" && !started) out.add("BROHDA_CANCELLED_NO_BREACH");
  }
  if (s.lifecycle === "SUSPENDED" || s.lifecycle === "LIVE") {
    out.add("SPONSOR_BREACH");
    out.add("BROHDA_LIVE_INTERRUPTION");
    if (!started) out.add("BROHDA_CANCELLED_NO_BREACH");
  }
  return [...out];
}

/** Which of the A–G cases a reason belongs to, for labelling. */
export function caseForReason(reason: RefundReason, ctx: { reviewStatus: SponsorshipReviewStatus }): RefundCaseId {
  switch (reason) {
    case "BROHDA_REJECTED": return "A";
    case "SPONSOR_CANCELLATION": return ctx.reviewStatus === "APPROVED" ? "C" : "B";
    case "BROHDA_CANCELLED_NO_BREACH": return "D";
    case "SPONSOR_BREACH":
    case "BROHDA_LIVE_INTERRUPTION": return "E";
    case "GAME_UNDELIVERABLE": return "F";
    case "COMPLETED_DELIVERED":
    case "BROHDA_NON_DELIVERY": return "G";
  }
}
