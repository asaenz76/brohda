// The pure, synchronous half of payment eligibility: is this sponsorship in a state where a payment can be asked of the Sponsor at all? No database, no provider — so it can be
// tested exhaustively and used anywhere. (The async half, which adds provider availability and legal acceptance, is payment-eligibility.ts.)
export type NotPayableReason = "CAPABILITY_OFF" | "ACCOUNT_NOT_ACTIVE" | "NOT_SUBMITTED" | "ALREADY_PAID" | "CANCELLED_OR_ENDED" | "NOT_PAYABLE_STATE";

export function paymentPhase(s: { lifecycle: string; paymentStatus: string }, ctx: { sponsorStatus: string; capabilityEnabled: boolean }): { payable: true } | { payable: false; reason: NotPayableReason } {
  if (!ctx.capabilityEnabled) return { payable: false, reason: "CAPABILITY_OFF" };
  if (ctx.sponsorStatus !== "ACTIVE") return { payable: false, reason: "ACCOUNT_NOT_ACTIVE" };
  if (["CANCELLED", "COMPLETED", "REJECTED"].includes(s.lifecycle)) return { payable: false, reason: "CANCELLED_OR_ENDED" };
  if (s.lifecycle !== "SUBMITTED") return { payable: false, reason: s.paymentStatus === "PAID" ? "ALREADY_PAID" : "NOT_SUBMITTED" };
  if (s.paymentStatus === "PAID" || s.paymentStatus === "REFUND_PENDING" || s.paymentStatus === "REFUNDED") return { payable: false, reason: "ALREADY_PAID" };
  if (s.paymentStatus === "PENDING" || s.paymentStatus === "FAILED") return { payable: true };
  return { payable: false, reason: "NOT_PAYABLE_STATE" };
}
