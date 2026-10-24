import { describe, expect, it } from "vitest";
import { derivePickState } from "@/lib/predictions/pick-state";

const pending = (over: Partial<{ lockedAt: string | null; lockReason: string | null; result: "CORRECT" | "INCORRECT" | "VOID" | null; lifecycleState: "PENDING" | "GRADED" }> = {}) => ({
  lifecycleState: "PENDING" as const,
  result: null,
  lockedAt: null,
  lockReason: null,
  ...over,
});

describe("derivePickState — Brohda 2.1 Pick states", () => {
  it("NO_PICK: a team can be chosen while T-10 has not passed, never after; Confidence needs a Pick", () => {
    expect(derivePickState({ prediction: null, staked: false, acceptedCallBs: false, windowOpen: true })).toEqual({ state: "NO_PICK", lockSources: [], canChangeTeam: true, canAttachConfidence: false });
    expect(derivePickState({ prediction: null, staked: false, acceptedCallBs: false, windowOpen: false }).canChangeTeam).toBe(false);
  });

  it("UNSTAKED_EDITABLE: the team may change and Confidence may be added", () => {
    expect(derivePickState({ prediction: pending(), staked: false, acceptedCallBs: false, windowOpen: true })).toEqual({ state: "UNSTAKED_EDITABLE", lockSources: [], canChangeTeam: true, canAttachConfidence: true });
  });

  it("UNSTAKED_LOCKED_T10: the deadline (passed, or already recorded as CUTOFF) closes both the team and Confidence", () => {
    const passed = derivePickState({ prediction: pending(), staked: false, acceptedCallBs: false, windowOpen: false });
    expect(passed).toEqual({ state: "UNSTAKED_LOCKED_T10", lockSources: ["T10"], canChangeTeam: false, canAttachConfidence: false });
    const recorded = derivePickState({ prediction: pending({ lockedAt: "2026-10-23T00:00:00Z", lockReason: "CUTOFF" }), staked: false, acceptedCallBs: false, windowOpen: true });
    expect(recorded.state).toBe("UNSTAKED_LOCKED_T10");
    expect(recorded.canAttachConfidence).toBe(false);
  });

  it("STAKED_LOCKED_CONFIDENCE: the team is locked from the moment Confidence is attached — even with the whole window still open — and nothing more can be added", () => {
    const s = derivePickState({ prediction: pending({ lockedAt: "2026-10-23T00:00:00Z", lockReason: "CONFIDENCE_COMMITTED" }), staked: true, acceptedCallBs: false, windowOpen: true });
    expect(s).toEqual({ state: "STAKED_LOCKED_CONFIDENCE", lockSources: ["CONFIDENCE"], canChangeTeam: false, canAttachConfidence: false });
  });

  it("LOCKED_CALL_BS: the team is locked, but Confidence can still be attached before T-10 (it is independent of Call BS)", () => {
    const s = derivePickState({ prediction: pending({ lockedAt: "2026-10-23T00:00:00Z", lockReason: "CHALLENGE_ACCEPTED" }), staked: false, acceptedCallBs: true, windowOpen: true });
    expect(s).toEqual({ state: "LOCKED_CALL_BS", lockSources: ["CALL_BS"], canChangeTeam: false, canAttachConfidence: true });
    expect(derivePickState({ prediction: pending({ lockedAt: "x", lockReason: "CHALLENGE_ACCEPTED" }), staked: false, acceptedCallBs: true, windowOpen: false }).canAttachConfidence).toBe(false);
  });

  it("lock sources overlap: a staked Pick in an accepted Call BS reports both, and the headline is Confidence", () => {
    const s = derivePickState({ prediction: pending({ lockedAt: "x", lockReason: "CHALLENGE_ACCEPTED" }), staked: true, acceptedCallBs: true, windowOpen: true });
    expect(s.state).toBe("STAKED_LOCKED_CONFIDENCE");
    expect(s.lockSources).toEqual(["CONFIDENCE", "CALL_BS"]);
  });

  it("GRADED and VOID are terminal: nothing can change or be added", () => {
    const graded = derivePickState({ prediction: pending({ lifecycleState: "GRADED", result: "CORRECT", lockedAt: "x" }), staked: false, acceptedCallBs: false, windowOpen: true });
    expect(graded).toMatchObject({ state: "GRADED", canChangeTeam: false, canAttachConfidence: false });
    const voided = derivePickState({ prediction: pending({ lifecycleState: "GRADED", result: "VOID", lockedAt: "x" }), staked: true, acceptedCallBs: false, windowOpen: false });
    expect(voided).toMatchObject({ state: "VOID", canChangeTeam: false, canAttachConfidence: false });
  });

  it("a Pick locked only by a retired reason is reported as such, never as editable", () => {
    expect(derivePickState({ prediction: pending({ lockedAt: "x", lockReason: "MONETARY_POSITION_ACCEPTED" }), staked: false, acceptedCallBs: false, windowOpen: true }).state).toBe("LOCKED_OTHER");
  });
});
