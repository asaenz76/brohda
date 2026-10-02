import { describe, expect, it } from "vitest";
import { resolveNotificationHref } from "@/lib/notifications/links";
import type { NotificationRow } from "@/lib/notifications/fetch";

function makeNotification(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "notif-1",
    type: "prediction_graded",
    title: "You were right",
    body: 'Your prediction on "Who wins?" was correct.',
    transaction_id: null,
    post_id: null,
    market_id: null,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveNotificationHref", () => {
  it("always points a wallet request submission at the admin queue", () => {
    const n = makeNotification({ type: "WALLET_REQUEST_SUBMITTED" });
    expect(resolveNotificationHref(n)).toBe("/admin/wallet-requests");
  });

  // Stage 4A remediation (Stage 4 audit §14 / remediation §17): a graded
  // Prediction's notification previously resolved to no destination at
  // all (no case existed for this type). Direct field read, resolved once
  // at creation time.
  it("falls back to the canonical Post when there's no market_id", () => {
    const n = makeNotification({ post_id: "post-1", market_id: null });
    expect(resolveNotificationHref(n)).toBe("/post/post-1");
  });

  it("returns null for a graded-prediction notification with neither market_id nor post_id (data anomaly)", () => {
    const n = makeNotification({ post_id: null, market_id: null });
    expect(resolveNotificationHref(n)).toBeNull();
  });

  // Stage 4C remediation: a Post can have more than one concurrently
  // ACTIVE Market — market_id disambiguates which one this specific
  // notification is about, rather than collapsing every prediction_graded
  // notification for the same Post to its primary Market.
  it("points a graded-prediction notification at its specific Market when market_id is present", () => {
    const n = makeNotification({ post_id: "post-1", market_id: "market-1" });
    expect(resolveNotificationHref(n)).toBe("/markets/market-1");
  });

  it("prefers market_id over post_id when both are present", () => {
    const n = makeNotification({ post_id: "post-1", market_id: "market-1" });
    expect(resolveNotificationHref(n)).toBe("/markets/market-1");
  });

  it("sends a monetary proposal notification to the Post, not the Market", () => {
    const n = makeNotification({ type: "MONETARY_PROPOSAL_RECEIVED", post_id: "post-1", market_id: "market-1" });
    expect(resolveNotificationHref(n)).toBe("/post/post-1");
  });

  it("routes an expired monetary proposal to the Post, then the Market", () => {
    expect(resolveNotificationHref(makeNotification({ type: "MONETARY_PROPOSAL_EXPIRED", post_id: "post-1", market_id: "market-1" }))).toBe("/post/post-1");
    expect(resolveNotificationHref(makeNotification({ type: "MONETARY_PROPOSAL_EXPIRED", post_id: null, market_id: "market-1" }))).toBe("/markets/market-1");
  });

  it("falls back to the Market for a monetary settlement when the Game has no Post yet", () => {
    const n = makeNotification({ type: "MONETARY_POSITION_SETTLED_WIN", post_id: null, market_id: "market-1" });
    expect(resolveNotificationHref(n)).toBe("/markets/market-1");
  });

  describe("Call BS notifications", () => {
    const CALL_BS_TYPES = ["CALL_BS_RECEIVED", "CALL_BS_ACCEPTED", "CALL_BS_DECLINED", "CALL_BS_RESOLVED"];

    it.each(CALL_BS_TYPES)("%s prefers the canonical Post over the Market", (type) => {
      const n = makeNotification({ type, post_id: "post-1", market_id: "market-1" });
      expect(resolveNotificationHref(n)).toBe("/post/post-1");
    });

    it.each(CALL_BS_TYPES)("%s falls back to the Market when the Game has no published Post", (type) => {
      const n = makeNotification({ type, post_id: null, market_id: "market-1" });
      expect(resolveNotificationHref(n)).toBe("/markets/market-1");
    });

    it.each(CALL_BS_TYPES)("%s resolves to nothing (never a dead link) with neither Post nor Market", (type) => {
      const n = makeNotification({ type, post_id: null, market_id: null });
      expect(resolveNotificationHref(n)).toBeNull();
    });
  });

  it("falls back to the stamped transaction_id's wallet entry when there's no post/market", () => {
    const n = makeNotification({ type: "DEPOSIT_APPROVED", transaction_id: "tx-direct" });
    expect(resolveNotificationHref(n)).toBe("/wallet#tx-tx-direct");
  });

  it("returns null when there's nothing to resolve to", () => {
    const n = makeNotification({ type: "DEPOSIT_APPROVED" });
    expect(resolveNotificationHref(n)).toBeNull();
  });
});
