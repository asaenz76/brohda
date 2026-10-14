import { describe, expect, it } from "vitest";
import { CHALLENGE_EXPIRY_REASONS, IGNORED_EXPIRY_REASONS, challengeResponseRate, expiryCountsAsIgnored } from "@/lib/challenges/expiry";

describe("Call BS expiry policy", () => {
  it("only a genuine NO_RESPONSE ever counts as ignored; every system or relationship cause is excluded", () => {
    expect(IGNORED_EXPIRY_REASONS).toEqual(["NO_RESPONSE"]);
    for (const reason of CHALLENGE_EXPIRY_REASONS) expect(expiryCountsAsIgnored(reason), reason).toBe(reason === "NO_RESPONSE");
    expect(expiryCountsAsIgnored(null)).toBe(false);
    expect(expiryCountsAsIgnored(undefined)).toBe(false);
    expect(expiryCountsAsIgnored("SOMETHING_NEW")).toBe(false); // an unrecognised cause never punishes anyone
  });

  it("names the six required semantic causes, plus the relationship one", () => {
    expect(CHALLENGE_EXPIRY_REASONS).toEqual(
      expect.arrayContaining(["NO_RESPONSE", "GAME_OR_MARKET_CANCELLED", "SYSTEM_INVALIDATED", "COMPETING_CHALLENGE_RESOLVED", "ACCOUNT_STATE_CHANGE", "OTHER_SYSTEM_REASON", "RELATIONSHIP_BLOCKED"]),
    );
  });

  it("response rate = answered / (answered + genuinely ignored); nothing to measure is null, never 0%", () => {
    expect(challengeResponseRate({ accepted: 0, declined: 0, ignored: 0 })).toBeNull();
    expect(challengeResponseRate({ accepted: 2, declined: 1, ignored: 1 })).toBeCloseTo(0.75);
    expect(challengeResponseRate({ accepted: 0, declined: 0, ignored: 3 })).toBe(0);
    expect(challengeResponseRate({ accepted: 4, declined: 0, ignored: 0 })).toBe(1);
  });
});
