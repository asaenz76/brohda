import { describe, expect, it } from "vitest";
import { buildPostSocial, toConversationSocial } from "@/lib/challenges/post-social";
import { buildGameCallBsStatus } from "@/lib/challenges/game-status";
import type { Challenge, ChallengeParticipant, ChallengeStatus } from "@/lib/challenges/types";

const VIEWER = "viewer";

function participant(userId: string, selectedOutcome: "YES" | "NO", overrides: Partial<ChallengeParticipant> = {}): ChallengeParticipant {
  return { userId, displayName: userId.toUpperCase(), username: userId, avatarUrl: null, predictionId: `pick-${userId}`, selectedOutcome, canCallBs: false, pairedInCallBs: false, ...overrides };
}

function challenge(overrides: Partial<Challenge> & { status: ChallengeStatus }): Challenge {
  return {
    id: "c1",
    marketId: "m1",
    challengerUserId: VIEWER,
    recipientUserId: "maria",
    challengerPredictionId: "pick-viewer",
    recipientPredictionId: "pick-maria",
    challengerSelectionSnapshot: "YES",
    recipientSelectionSnapshot: "NO",
    expiryReason: null,
    result: null,
    acceptedAt: null,
    declinedAt: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const labelFor = (outcome: "YES" | "NO") => (outcome === "YES" ? "Chiefs" : "Bills");
const NO_H2H = new Map();

function social(participants: ChallengeParticipant[], challenges: Challenge[] = [], extra: { headToHead?: Map<string, { wins: number; losses: number; voids: number }>; pastCutoff?: boolean } = {}) {
  return buildPostSocial({ marketId: "m1", viewerId: VIEWER, participants, challenges, headToHead: extra.headToHead ?? NO_H2H, pastCutoff: extra.pastCutoff ?? false, labelFor });
}

describe("buildPostSocial", () => {
  it("is null when the viewer has no Pick: commit-before-crowd, no sides and no controls leak", () => {
    expect(social([participant("maria", "NO", { canCallBs: true })])).toBeNull();
  });

  it("labels every Member's side and relation to the viewer, and names the side the viewer did not pick", () => {
    const result = social([participant(VIEWER, "YES"), participant("maria", "NO"), participant("sam", "YES")])!;
    expect(result.viewer).toEqual({ outcome: "YES", label: "Chiefs" });
    expect(result.otherLabel).toBe("Bills");
    expect(result.byUserId[VIEWER]).toMatchObject({ relation: "self", label: "Chiefs", action: null });
    expect(result.byUserId.maria).toMatchObject({ relation: "opposite", label: "Bills", outcome: "NO" });
    expect(result.byUserId.sam).toMatchObject({ relation: "same", label: "Chiefs" });
  });

  it("offers Call BS only where the server said it is possible (canCallBs), and never on the same side or yourself", () => {
    const result = social([participant(VIEWER, "YES"), participant("maria", "NO", { canCallBs: true }), participant("sam", "YES", { canCallBs: false })])!;
    expect(result.byUserId.maria.action).toEqual({ kind: "call_bs", recipientPredictionId: "pick-maria" });
    expect(result.byUserId.sam.action).toBeNull();
    expect(result.byUserId[VIEWER].action).toBeNull();
  });

  it("an incoming Call BS is answered in the Your Call BS block, so the Member's row only names it", () => {
    const incoming = challenge({ status: "PENDING", challengerUserId: "maria", recipientUserId: VIEWER, challengerPredictionId: "pick-maria", recipientPredictionId: "pick-viewer", challengerSelectionSnapshot: "NO", recipientSelectionSnapshot: "YES" });
    const result = social([participant(VIEWER, "YES"), participant("maria", "NO", { canCallBs: true })], [incoming])!;
    expect(result.byUserId.maria.action).toEqual({ kind: "called_on_you" });
  });

  it("carries the other states through unchanged: pending, accepted, in another Call BS, no longer available, pick changed", () => {
    const outgoing = challenge({ status: "PENDING" });
    expect(social([participant(VIEWER, "YES"), participant("maria", "NO")], [outgoing])!.byUserId.maria.action).toEqual({ kind: "outgoing_pending" });
    expect(social([participant(VIEWER, "YES"), participant("maria", "NO")], [challenge({ status: "ACCEPTED" })])!.byUserId.maria.action).toEqual({ kind: "accepted" });
    expect(social([participant(VIEWER, "YES"), participant("maria", "NO", { pairedInCallBs: true })])!.byUserId.maria.action).toEqual({ kind: "in_call_bs" });
    expect(social([participant(VIEWER, "YES"), participant("maria", "NO")], [challenge({ status: "EXPIRED", expiryReason: "PICK_CHANGED" })])!.byUserId.maria.action).toEqual({ kind: "unavailable", pickChanged: true });
    // A pending one past the deadline is not offered as answerable.
    expect(social([participant(VIEWER, "YES"), participant("maria", "NO")], [outgoing], { pastCutoff: true })!.byUserId.maria.action).toEqual({ kind: "unavailable" });
  });

  it("includes the head-to-head record only when there is resolved history", () => {
    const h2h = new Map([
      ["maria", { wins: 3, losses: 1, voids: 0 }],
      ["sam", { wins: 0, losses: 0, voids: 2 }],
    ]);
    const result = social([participant(VIEWER, "YES"), participant("maria", "NO"), participant("sam", "NO")], [], { headToHead: h2h })!;
    expect(result.byUserId.maria.headToHead).toEqual({ wins: 3, losses: 1 });
    expect(result.byUserId.sam.headToHead).toBeNull();
  });

  it("the conversation receives a plain, serializable object with no server-only extras", () => {
    const result = social([participant(VIEWER, "YES"), participant("maria", "NO")])!;
    const forClient = toConversationSocial(result);
    expect(Object.keys(forClient).sort()).toEqual(["byUserId", "marketId", "otherLabel", "viewer"]);
    expect(() => JSON.stringify(forClient)).not.toThrow();
    expect(JSON.parse(JSON.stringify(forClient))).toEqual(forClient);
  });
});

describe("buildGameCallBsStatus", () => {
  const labels = (_marketId: string, outcome: "YES" | "NO") => labelFor(outcome);
  const profiles = new Map([
    ["maria", { name: "Maria", username: "maria" }],
    ["sam", { name: "Sam", username: null }],
  ]);

  it("describes each Call BS from the viewer's side using the stored snapshots, in display order", () => {
    const status = buildGameCallBsStatus({
      viewerId: VIEWER,
      challenges: [
        challenge({ id: "done", status: "RESOLVED", result: "CHALLENGER_WON", recipientUserId: "sam" }),
        challenge({ id: "incoming", status: "PENDING", challengerUserId: "maria", recipientUserId: VIEWER, challengerSelectionSnapshot: "NO", recipientSelectionSnapshot: "YES" }),
      ],
      profiles,
      labelFor: labels,
      pastCutoff: false,
    });
    expect(status.items.map((i) => i.challenge.id)).toEqual(["incoming", "done"]);
    expect(status.items[0].view.canRespond).toBe(true);
    expect(status.items[0].view.detail).toContain("You picked Chiefs. Maria picked Bills.");
    expect(status.items[1].view.outcome).toBe("WON");
    expect(status.more).toBe(0);
  });

  it("reads the sides as they were when the Call BS was made, not from anyone's current Pick", () => {
    const status = buildGameCallBsStatus({
      viewerId: VIEWER,
      challenges: [challenge({ status: "ACCEPTED", challengerSelectionSnapshot: "NO", recipientSelectionSnapshot: "YES" })],
      profiles,
      labelFor: labels,
      pastCutoff: false,
    });
    expect(status.items[0].view.detail).toContain("You picked Bills. Maria picked Chiefs.");
  });

  it("an opponent whose profile is gone still reads sensibly", () => {
    const status = buildGameCallBsStatus({ viewerId: VIEWER, challenges: [challenge({ status: "ACCEPTED", recipientUserId: "ghost" })], profiles, labelFor: labels, pastCutoff: false });
    expect(status.items[0].opponent.name).toBe("A Member");
  });

  it("caps the list and reports how many more there are", () => {
    const many = Array.from({ length: 9 }, (_, i) => challenge({ id: `c${i}`, status: "PENDING", recipientUserId: "maria", updatedAt: `2026-01-0${(i % 9) + 1}T00:00:00Z` }));
    const status = buildGameCallBsStatus({ viewerId: VIEWER, challenges: many, profiles, labelFor: labels, pastCutoff: false, limit: 6 });
    expect(status.items).toHaveLength(6);
    expect(status.more).toBe(3);
  });
});
