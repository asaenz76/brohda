import { describe, expect, it } from "vitest";
import { deriveChallengeActionState } from "@/lib/challenges/action-state";
import type { Challenge, ChallengeStatus } from "@/lib/challenges/types";

const VIEWER = "viewer";
const OTHER = "other";
const OTHER_PICK = "other-pick";
const VIEWER_PICK = "viewer-pick";

function challenge(overrides: Partial<Challenge> & { status: ChallengeStatus }): Challenge {
  return {
    id: "challenge-1",
    marketId: "market-1",
    challengerUserId: VIEWER,
    recipientUserId: OTHER,
    challengerPredictionId: VIEWER_PICK,
    recipientPredictionId: OTHER_PICK,
    challengerSelectionSnapshot: "YES",
    recipientSelectionSnapshot: "NO",
    result: null,
    acceptedAt: null,
    declinedAt: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function derive(challenges: Challenge[], opts: { canCallBs?: boolean; pastCutoff?: boolean; pairedInCallBs?: boolean } = {}) {
  return deriveChallengeActionState({
    viewerId: VIEWER,
    participantPredictionId: OTHER_PICK,
    canCallBs: opts.canCallBs ?? false,
    pairedInCallBs: opts.pairedInCallBs ?? false,
    challenges,
    pastCutoff: opts.pastCutoff ?? false,
  });
}

// The row the viewer sees when the OTHER user called BS on the viewer.
const incoming = (status: ChallengeStatus) =>
  challenge({ status, challengerUserId: OTHER, recipientUserId: VIEWER, challengerPredictionId: OTHER_PICK, recipientPredictionId: VIEWER_PICK });

describe("deriveChallengeActionState", () => {
  it("offers Call BS only when eligible and nothing already links the pair", () => {
    expect(derive([], { canCallBs: true })).toEqual({ kind: "call_bs", recipientPredictionId: OTHER_PICK });
    expect(derive([], { canCallBs: false })).toBeNull();
  });

  it("shows Accept/Decline for an incoming PENDING Challenge before cutoff", () => {
    expect(derive([incoming("PENDING")])).toEqual({ kind: "incoming_pending", challengeId: "challenge-1" });
  });

  it("shows Pending for an outgoing PENDING Challenge before cutoff", () => {
    expect(derive([challenge({ status: "PENDING" })])).toEqual({ kind: "outgoing_pending" });
  });

  // Expiry of PENDING rows is lazy in the database — nothing sweeps them at
  // cutoff — so the UI itself must refuse to render an Accept the server
  // would only reject.
  it("renders an incoming PENDING Challenge past cutoff as unavailable — no Accept/Decline", () => {
    const state = derive([incoming("PENDING")], { pastCutoff: true });
    expect(state).toEqual({ kind: "unavailable" });
    expect(state?.kind).not.toBe("incoming_pending");
  });

  it("renders an outgoing PENDING Challenge past cutoff as unavailable instead of an eternal Pending", () => {
    expect(derive([challenge({ status: "PENDING" })], { pastCutoff: true })).toEqual({ kind: "unavailable" });
  });

  it("does not offer a fresh Call BS past cutoff even if the flag says eligible is false", () => {
    expect(derive([], { canCallBs: false, pastCutoff: true })).toBeNull();
  });

  it("shows Accepted regardless of cutoff", () => {
    expect(derive([challenge({ status: "ACCEPTED" })], { pastCutoff: true })).toEqual({ kind: "accepted" });
    expect(derive([challenge({ status: "ACCEPTED" })], { pastCutoff: false })).toEqual({ kind: "accepted" });
  });

  it("shows a displaced (EXPIRED) Challenge as unavailable — never as Declined", () => {
    const state = derive([incoming("EXPIRED")]);
    expect(state).toEqual({ kind: "unavailable" });
    expect(state?.kind).not.toBe("declined");
  });

  it("prefers ACCEPTED over PENDING over EXPIRED when several match the same pair", () => {
    const expired = challenge({ id: "old", status: "EXPIRED" });
    const pending = challenge({ id: "mid", status: "PENDING" });
    const accepted = challenge({ id: "new", status: "ACCEPTED" });
    expect(derive([expired, pending, accepted])).toEqual({ kind: "accepted" });
    expect(derive([expired, pending])).toEqual({ kind: "outgoing_pending" });
    expect(derive([expired], { canCallBs: true })).toEqual({ kind: "unavailable" });
  });

  it("ignores DECLINED and RESOLVED rows (only ever shown via the client's own post-action state)", () => {
    expect(derive([incoming("DECLINED")], { canCallBs: true })).toEqual({ kind: "call_bs", recipientPredictionId: OTHER_PICK });
    expect(derive([incoming("RESOLVED")], { canCallBs: false })).toBeNull();
  });

  it("ignores Challenges that belong to a different participant's pair", () => {
    const unrelated = challenge({ status: "PENDING", recipientPredictionId: "someone-else-pick", recipientUserId: "someone-else" });
    expect(derive([unrelated], { canCallBs: true })).toEqual({ kind: "call_bs", recipientPredictionId: OTHER_PICK });
  });

  describe("participant already in a Call BS with someone else", () => {
    it("explains the missing button instead of staying silent", () => {
      expect(derive([], { canCallBs: false, pairedInCallBs: true })).toEqual({ kind: "in_call_bs" });
    });

    it("never hides a real Call BS: eligibility wins if both are somehow set", () => {
      expect(derive([], { canCallBs: true, pairedInCallBs: true })).toEqual({ kind: "call_bs", recipientPredictionId: OTHER_PICK });
    });

    it("shows Accepted, not 'In a Call BS', when the participant is the viewer's own partner", () => {
      expect(derive([challenge({ status: "ACCEPTED" })], { pairedInCallBs: true })).toEqual({ kind: "accepted" });
    });

    it("keeps an existing PENDING challenge with that participant visible as Pending", () => {
      expect(derive([challenge({ status: "PENDING" })], { pairedInCallBs: true })).toEqual({ kind: "outgoing_pending" });
    });

    it("says nothing when the participant is not paired and not eligible", () => {
      expect(derive([], { canCallBs: false, pairedInCallBs: false })).toBeNull();
    });
  });
});
