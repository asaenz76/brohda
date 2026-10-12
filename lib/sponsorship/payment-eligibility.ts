import "server-only";
import { resolveOnlinePayment } from "@/lib/payments/active-provider";
import { sponsorCommercialLegalStatus, type LegalRequirement } from "@/lib/sponsor/commercial-legal-gate";
import { paymentPhase, type NotPayableReason } from "./payment-phase";

// THE answer to "may this Sponsor pay for this sponsorship online right now?" — one function, used by the dashboard, the sponsorship page and (through the same underlying gates)
// the payment service, so a Pay now button is shown only when starting the payment would actually be accepted, and never when it wouldn't.
//
//   NOT_PAYABLE         nothing to pay (see reason: account, capability, not submitted, already paid, cancelled/ended)
//   ONLINE_UNAVAILABLE  payable, but online payment is off, or the selected provider isn't configured/available — manual payment remains
//   LEGAL_BLOCKED       payable and offered, but a required Sponsor Terms / agreement acceptance is missing (a DRAFT document requires nothing)
//   PAY_NOW             every gate passes
//
// The provider is never named here: availability comes from the provider registry/policy, the legal state from the commercial legal gate.
export type PaymentEligibility =
  | { state: "NOT_PAYABLE"; reason: NotPayableReason }
  | { state: "ONLINE_UNAVAILABLE" }
  | { state: "LEGAL_BLOCKED"; missing: LegalRequirement[] }
  | { state: "PAY_NOW" };

type Online = Awaited<ReturnType<typeof resolveOnlinePayment>>;

export async function sponsorPaymentEligibility(input: {
  userId: string;
  sponsorStatus: string;
  capabilityEnabled: boolean;
  sponsorship: { id: string; lifecycle: string; paymentStatus: string };
  /** Pass the already-resolved online state when checking many sponsorships (the dashboard), so the provider policy is read once. */
  online?: Online;
}): Promise<PaymentEligibility> {
  const phase = paymentPhase({ lifecycle: input.sponsorship.lifecycle, paymentStatus: input.sponsorship.paymentStatus }, { sponsorStatus: input.sponsorStatus, capabilityEnabled: input.capabilityEnabled });
  if (!phase.payable) return { state: "NOT_PAYABLE", reason: phase.reason };
  const online = input.online ?? (await resolveOnlinePayment());
  if (online.state !== "available" || !online.offered) return { state: "ONLINE_UNAVAILABLE" };
  const legal = await sponsorCommercialLegalStatus({ userId: input.userId, sponsorshipId: input.sponsorship.id, stage: "PAYMENT" });
  if (!legal.ok) return { state: "LEGAL_BLOCKED", missing: legal.missing };
  return { state: "PAY_NOW" };
}
