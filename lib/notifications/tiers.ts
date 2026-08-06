export type NotificationTier = 1 | 2 | 3 | 4;

const TIER_1 = new Set(["SETTLED_WON", "SETTLED_LOST"]);
const TIER_2 = new Set([
  "COMMENT_REPLY",
  "COMMENT_MENTION",
  "FOLLOWED_USER_ENTERED_POOL",
  "POOL_PUBLISHED_FOLLOWED",
]);
const TIER_3 = new Set([
  "QUICK_TOPUP_ENTERED",
  "QUICK_TOPUP_FUNDS_AVAILABLE",
  "DEPOSIT_APPROVED",
  "WITHDRAWAL_APPROVED",
  "DEPOSIT_REJECTED",
  "WITHDRAWAL_REJECTED",
]);

// Tier 4 is the default, not enumerated — it covers WALLET_REQUEST_SUBMITTED
// plus every pool-status notice type from lib/pools/notices.ts
// (MANUAL_REVIEW, LOCKED, READY_FOR_REVIEW, `${status}_PENDING`, and the
// open-ended void/cancel reason strings). An unrecognized future type falls
// through safely rather than being miscategorized as significant.
export function getNotificationTier(type: string): NotificationTier {
  if (TIER_1.has(type)) return 1;
  if (TIER_2.has(type)) return 2;
  if (TIER_3.has(type)) return 3;
  return 4;
}
