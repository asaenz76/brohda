import type { SponsorshipLifecycle, SponsorshipPaymentStatus, SponsorshipReviewStatus } from "./types";

/** An amount in the currency's minor units (cents) in its own currency — never assumes USD. */
export function formatCommercialAmount(cents: number | null, currency: string | null): string {
  if (cents === null || cents === undefined) return "—";
  const plain = `${(cents / 100).toFixed(2)} ${currency ?? ""}`.trim();
  if (!currency) return plain;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return plain;
  }
}

export interface StatusCopy {
  label: string;
  detail: string;
}

/**
 * The sponsor-facing status in plain words. It keeps three things visibly apart: what has been RECEIVED (payment), what has been DECIDED (Brohda's
 * approval) and what is HAPPENING (scheduled / live). No wording implies that paying guarantees approval.
 */
export function sponsorStatusCopy(s: { lifecycle: SponsorshipLifecycle; reviewStatus: SponsorshipReviewStatus; paymentStatus: SponsorshipPaymentStatus }): StatusCopy {
  switch (s.lifecycle) {
    case "DRAFT":
      return { label: "Draft", detail: "Not submitted yet. You can keep editing." };
    case "SUBMITTED": {
      if (s.reviewStatus === "CHANGES_REQUESTED") return { label: "Changes requested", detail: "Brohda asked for changes. Update the sponsorship and submit it again." };
      const paid = s.paymentStatus === "PAID";
      const approved = s.reviewStatus === "APPROVED";
      if (paid && approved) return { label: "Paid and approved", detail: "Everything is confirmed. It will be scheduled automatically." };
      if (paid) return { label: "Payment received — awaiting Brohda approval", detail: "Payment is confirmed. Brohda still has to review and approve it; payment does not guarantee approval." };
      if (approved) return { label: "Approved — awaiting payment", detail: "Brohda approved it. It can be scheduled once payment is confirmed." };
      return { label: "Submitted — awaiting payment and review", detail: "Brohda needs to confirm payment and review it before anything is shown." };
    }
    case "SCHEDULED":
      return { label: "Approved and scheduled", detail: "It will appear on the Game Post when its campaign window opens." };
    case "LIVE":
      return { label: "Live", detail: "It is showing on the Game Post now." };
    case "SUSPENDED":
      return { label: "Suspended", detail: "Brohda paused it. It is not shown." };
    case "COMPLETED":
      return { label: "Completed", detail: "The campaign has ended." };
    case "REJECTED":
      return { label: "Not approved", detail: "Brohda did not approve this sponsorship." };
    case "CANCELLED":
      return { label: "Cancelled", detail: "This sponsorship was cancelled." };
  }
}

export const PAYMENT_STATUS_LABEL: Record<SponsorshipPaymentStatus, string> = {
  UNPAID: "Unpaid",
  PENDING: "Awaiting payment",
  PAID: "Paid",
  FAILED: "Payment failed",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
  CANCELLED: "Payment cancelled",
};

/** Which states a sponsor may still edit in (kept in step with the database rule in sponsor_update_sponsorship). */
export const sponsorCanEdit = (s: { lifecycle: SponsorshipLifecycle; reviewStatus: SponsorshipReviewStatus }): boolean =>
  s.lifecycle === "DRAFT" || (s.lifecycle === "SUBMITTED" && s.reviewStatus === "CHANGES_REQUESTED");
