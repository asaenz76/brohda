import { beforeEach, describe, expect, it, vi } from "vitest";

// M4: the Call BS server action refuses a Call BS that could never be accepted (either Member is already in an accepted one on the Game), before it reaches the database or notifies anyone.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ id: "challenger-1" })),
  callBS: vi.fn(),
  acceptCallBS: vi.fn(),
  declineCallBS: vi.fn(),
  hasAcceptedCallBsAmong: vi.fn(),
  getPredictionById: vi.fn(),
  checkCallBsRateLimit: vi.fn(async () => true),
  deliver: vi.fn(async () => ({ delivered: true })),
  revalidate: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/challenges/repository", () => ({ callBS: mocks.callBS, acceptCallBS: mocks.acceptCallBS, declineCallBS: mocks.declineCallBS, hasAcceptedCallBsAmong: mocks.hasAcceptedCallBsAmong }));
vi.mock("@/lib/predictions/repository", () => ({ getPredictionById: mocks.getPredictionById }));
vi.mock("@/lib/rate-limit/challenges", () => ({ checkCallBsRateLimit: mocks.checkCallBsRateLimit }));
vi.mock("@/lib/notifications/challenges", () => ({
  createChallengeReceivedNotification: vi.fn(),
  createChallengeAcceptedNotification: vi.fn(),
  createChallengeDeclinedNotification: vi.fn(),
  deliverChallengeNotification: mocks.deliver,
}));
vi.mock("@/lib/revalidate/market-surfaces", () => ({ revalidateMarketSurfaces: mocks.revalidate }));

import { callBSAction } from "@/lib/actions/challenges";

const PICK_ID = "11111111-1111-4111-8111-111111111111";
const challenge = { id: "ch-1", marketId: "market-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPredictionById.mockResolvedValue({ id: PICK_ID, marketId: "market-1", userId: "recipient-1" });
  mocks.hasAcceptedCallBsAmong.mockResolvedValue(false);
  mocks.callBS.mockResolvedValue({ ok: true, challenge });
});

describe("callBSAction", () => {
  it("sends the Call BS when neither Member is in an accepted one, and notifies the recipient", async () => {
    const result = await callBSAction(PICK_ID, "market-1");
    expect(result).toEqual({ error: null, challenge });
    expect(mocks.hasAcceptedCallBsAmong).toHaveBeenCalledWith("market-1", ["challenger-1", "recipient-1"]);
    expect(mocks.callBS).toHaveBeenCalledWith("challenger-1", PICK_ID);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });

  it("refuses it, in words, when either Member is already in an accepted Call BS on the Game — nothing is created and nobody is notified", async () => {
    mocks.hasAcceptedCallBsAmong.mockResolvedValue(true);
    const result = await callBSAction(PICK_ID, "market-1");
    expect(result).toEqual({ error: "You or they are already in a Call BS on this game.", challenge: null });
    expect(mocks.callBS).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("derives the challenger from the session and the Market from the Pick, never from the client's marketId", async () => {
    await callBSAction(PICK_ID, "some-other-market-from-the-client");
    expect(mocks.hasAcceptedCallBsAmong).toHaveBeenCalledWith("market-1", ["challenger-1", "recipient-1"]);
  });

  it("still lets the database say a Pick does not exist", async () => {
    mocks.getPredictionById.mockResolvedValue(null);
    mocks.callBS.mockResolvedValue({ ok: false, error: "recipient_pick_not_found" });
    const result = await callBSAction(PICK_ID, "market-1");
    expect(result.error).toBe("That pick couldn't be found.");
    expect(mocks.hasAcceptedCallBsAmong).not.toHaveBeenCalled();
  });

  it("rejects a malformed Pick id and respects the rate limit before anything is read", async () => {
    expect((await callBSAction("not-a-uuid", "market-1")).error).toBe("Invalid pick.");
    mocks.checkCallBsRateLimit.mockResolvedValueOnce(false);
    expect((await callBSAction(PICK_ID, "market-1")).error).toBe("Too many Call BS attempts. Try again in a moment.");
    expect(mocks.getPredictionById).not.toHaveBeenCalled();
  });
});
