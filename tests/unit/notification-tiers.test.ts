import { describe, expect, it } from "vitest";
import { getNotificationTier } from "@/lib/notifications/tiers";

describe("getNotificationTier", () => {
  it("classifies win/loss settlement as tier 1", () => {
    expect(getNotificationTier("SETTLED_WON")).toBe(1);
    expect(getNotificationTier("SETTLED_LOST")).toBe(1);
  });

  it("classifies social events as tier 2", () => {
    for (const t of ["COMMENT_REPLY", "COMMENT_MENTION", "FOLLOWED_USER_ENTERED_POOL", "POOL_PUBLISHED_FOLLOWED"]) {
      expect(getNotificationTier(t)).toBe(2);
    }
  });

  it("classifies money events as tier 3", () => {
    for (const t of [
      "QUICK_TOPUP_ENTERED",
      "QUICK_TOPUP_FUNDS_AVAILABLE",
      "DEPOSIT_APPROVED",
      "WITHDRAWAL_APPROVED",
      "DEPOSIT_REJECTED",
      "WITHDRAWAL_REJECTED",
    ]) {
      expect(getNotificationTier(t)).toBe(3);
    }
  });

  it("defaults pool-status notice types and unknown types to tier 4", () => {
    for (const t of [
      "WALLET_REQUEST_SUBMITTED",
      "MANUAL_REVIEW",
      "LOCKED",
      "READY_FOR_REVIEW",
      "SUSPENDED_PENDING",
      "VOIDED",
      "MINIMUM_ENTRIES_NOT_REACHED",
      "SOME_FUTURE_TYPE",
    ]) {
      expect(getNotificationTier(t)).toBe(4);
    }
  });
});
