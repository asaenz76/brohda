import { describe, expect, it } from "vitest";
import { isMessagingSuccess, messagingOutcomeCopy } from "@/lib/messaging/outcomes";

describe("what a Member reads", () => {
  it("every outcome the database can answer has plain words, and an unknown one falls back safely", () => {
    for (const o of ["messaging_disabled", "self", "unavailable", "blocked_by_you", "empty", "too_long", "request_limit", "request_pending_accept_first", "duplicate_message", "rate_limited", "not_found", "unsent", "unsend_disabled", "window_expired", "accepted", "declined", "not_pending", "reported", "already_reported", "own_message", "invalid_share", "share_unavailable"]) {
      expect(messagingOutcomeCopy(o).length, o).toBeGreaterThan(5);
    }
    expect(messagingOutcomeCopy("something_new")).toBe(messagingOutcomeCopy("error"));
    expect(messagingOutcomeCopy(undefined)).toBe(messagingOutcomeCopy("error"));
  });

  it("'unavailable' never reveals WHY a Member can't be messaged (a block, an inactive account, a non-Member read the same)", () => {
    const text = messagingOutcomeCopy("unavailable").toLowerCase();
    expect(text).not.toMatch(/block|inactive|deactivat|closed|suspend|sponsor/);
  });

  it("states the configured limit, not a number baked into the copy", () => {
    expect(messagingOutcomeCopy("too_long", 321)).toContain("321");
    expect(messagingOutcomeCopy("too_long", 1500)).toContain("1,500");
  });

  it("no outcome copy uses bet, wager, wallet or money language", () => {
    for (const o of ["sent", "request_limit", "rate_limited", "reported", "invalid_share"]) expect(messagingOutcomeCopy(o)).not.toMatch(/\b(bet|wager|wallet|odds|cash)\b/i);
  });

  it("success is only the outcomes that mean it happened", () => {
    for (const o of ["sent", "unsent", "accepted", "declined", "reported"]) expect(isMessagingSuccess(o), o).toBe(true);
    for (const o of ["request_limit", "unavailable", "empty", "rate_limited", "already_reported", undefined]) expect(isMessagingSuccess(o as string), String(o)).toBe(false);
  });
});
