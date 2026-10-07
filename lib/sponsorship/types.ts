// Sponsorship domain types. The three state columns are orthogonal on purpose (lifecycle x review x payment): no loosely interpreted booleans.
export const SPONSOR_STATUSES = ["ACTIVE", "SUSPENDED", "DISABLED"] as const;
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];

export const SPONSORSHIP_LIFECYCLES = ["DRAFT", "SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED", "COMPLETED", "REJECTED", "CANCELLED"] as const;
export type SponsorshipLifecycle = (typeof SPONSORSHIP_LIFECYCLES)[number];

export const SPONSORSHIP_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED"] as const;
export type SponsorshipReviewStatus = (typeof SPONSORSHIP_REVIEW_STATUSES)[number];

export const SPONSORSHIP_PAYMENT_STATUSES = ["UNPAID", "PENDING", "PAID", "FAILED", "REFUND_PENDING", "REFUNDED", "CANCELLED"] as const;
export type SponsorshipPaymentStatus = (typeof SPONSORSHIP_PAYMENT_STATUSES)[number];

/** Everything the single public-eligibility policy needs, as supplied by the sponsorship_eligibility_inputs view. */
export interface SponsorshipEligibilityInputs {
  id: string;
  postId: string;
  marketCode: string;
  lifecycle: SponsorshipLifecycle;
  paymentStatus: SponsorshipPaymentStatus;
  reviewStatus: SponsorshipReviewStatus;
  startsAt: string;
  endsAt: string;
  /** The stored approval hash still matches the content as currently written (approve-then-swap is impossible). */
  approvalIntact: boolean;
  sponsorStatus: SponsorStatus;
  postPublished: boolean;
  fixtureStatus: string;
  hasDestination: boolean;
}

/**
 * The ONLY shape that reaches an ordinary member's browser: what is needed to render an active sponsorship — never prices, payment, review notes,
 * contact details, internal names, audit data or the raw destination (the click goes through a first-party redirect).
 */
export interface PublicSponsorship {
  id: string;
  presentedBy: string;
  tagline: string | null;
  ctaText: string | null;
  /** A public URL for the sponsor's logo, or null. */
  logoUrl: string | null;
  promotion: PublicPromotion | null;
}

export interface PublicPromotion {
  title: string;
  description: string | null;
  prizeDescription: string | null;
  officialRulesUrl: string;
  /** Who runs the promotion — the sponsor or its named third party, never Brohda. */
  fulfillmentName: string;
  eligibilitySummary: string | null;
}
