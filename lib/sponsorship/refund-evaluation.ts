import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RefundEvaluation, RefundReason } from "./refund-policy";

/**
 * evaluateSponsorshipRefundEligibility(sponsorship, reason, now): the ONE refund-eligibility decision, answered by the database from the canonical Game start
 * time and the configured cutoff. `now` is a parameter so the boundary can be tested with server-controlled time (never a wall-clock sleep); in the app it is
 * the database's own clock. Server-side only — the browser never computes it.
 */
export async function evaluateSponsorshipRefundEligibility(sponsorshipId: string, reason: RefundReason, now?: Date): Promise<RefundEvaluation> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("sponsorship_refund_evaluation", { p_id: sponsorshipId, p_reason: reason, ...(now ? { p_now: now.toISOString() } : {}) });
  if (error || !data) throw new Error(error?.message ?? "refund evaluation failed");
  return data as RefundEvaluation;
}

export interface CancellationRecord {
  initiator: "SPONSOR" | "BROHDA";
  cancelledAt: string;
  kickoffAt: string;
  cutoffHours: number;
  cutoffAt: string;
  reasonCode: string;
  refundEligible: boolean;
  moneyReceived: boolean;
  paymentStatus: string;
}

/** The frozen decision recorded when this sponsorship was cancelled, if it was. */
export async function getCancellationRecord(sponsorshipId: string): Promise<CancellationRecord | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsorship_cancellations").select("*").eq("sponsorship_id", sponsorshipId).maybeSingle();
  if (!data) return null;
  return { initiator: data.initiator, cancelledAt: data.cancelled_at, kickoffAt: data.kickoff_at, cutoffHours: data.cutoff_hours, cutoffAt: data.cutoff_at, reasonCode: data.reason_code, refundEligible: data.refund_eligible, moneyReceived: data.money_received, paymentStatus: data.payment_status };
}
