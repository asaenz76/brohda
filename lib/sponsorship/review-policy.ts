// WHAT COUNTS AS "AWAITING REVIEW" in the Sponsorship admin — defined once, here, in canonical statuses. The Review queue shows ONLY objects that need a decision from Super Admin
// right now, and the count on its tab counts exactly those; nothing else (active Sponsors, approved/paid/live/cancelled/completed sponsorships, settings, payment or legal status)
// is ever a review item. Both the lists and the count query the database with these filters — the UI never fetches broadly and filters loosely.
//
//   Sponsor account       status = PENDING_REVIEW       (an application waiting to be activated or rejected)
//   Sponsorship request   lifecycle = SUBMITTED  AND  review_status = PENDING
//                         (submitted or resubmitted, waiting for Super Admin's approve / request changes / reject — whether or not it has been paid yet: payment
//                         never approves, so an unpaid submission still needs its review). CHANGES_REQUESTED waits on the Sponsor, not on us, so it is not here.
//
// Future reviewable objects are added here (and only here).
export const REVIEWABLE_SPONSOR_STATUS = "PENDING_REVIEW";
export const REVIEWABLE_SPONSORSHIP = { lifecycle: "SUBMITTED", reviewStatus: "PENDING" } as const;

export interface ReviewCounts {
  sponsorApplications: number;
  sponsorships: number;
  total: number;
}

export const reviewTabLabel = (count: number): string => (count > 0 ? `Review queue (${count})` : "Review queue");
