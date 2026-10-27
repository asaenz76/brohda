import { describe, expect, it } from "vitest";
import { challengeOutcomeForViewer, describeChallengeForViewer, sortChallengeViews } from "@/lib/challenges/presentation";
import type { Challenge, ChallengeStatus } from "@/lib/challenges/types";

const ME = "me";
const THEM = "them";

function challenge(overrides: Partial<Challenge> & { status: ChallengeStatus }): Challenge {
  return {
    id: "c1",
    marketId: "m1",
    challengerUserId: ME,
    recipientUserId: THEM,
    challengerPredictionId: "p-me",
    recipientPredictionId: "p-them",
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

const describeIt = (c: Challenge, viewerId = ME, pastCutoff = false) =>
  describeChallengeForViewer({ challenge: c, viewerId, opponentName: "Maria", yourPickLabel: "Chiefs", theirPickLabel: "Bills", pastCutoff });

describe("describeChallengeForViewer — every state reads clearly from the viewer's side", () => {
  it("an outgoing PENDING Call BS says who, which sides, and that it is waiting", () => {
    const v = describeIt(challenge({ status: "PENDING" }));
    expect(v.tone).toBe("waiting");
    expect(v.headline).toBe("You called BS on Maria");
    expect(v.detail).toContain("You picked Chiefs. Maria picked Bills.");
    expect(v.detail).toContain("Waiting for Maria to accept");
    expect(v.canRespond).toBe(false);
  });

  it("an incoming PENDING Call BS is the one state that needs an answer, and says accepting locks the picks", () => {
    const v = describeIt(challenge({ status: "PENDING", challengerUserId: THEM, recipientUserId: ME, challengerSelectionSnapshot: "NO", recipientSelectionSnapshot: "YES" }));
    expect(v.tone).toBe("action");
    expect(v.canRespond).toBe(true);
    expect(v.headline).toBe("Maria called BS on you");
    expect(v.detail).toContain("Accept and both picks lock");
  });

  it("a PENDING Call BS past the deadline is expired for both sides, never answerable and never an eternal 'waiting'", () => {
    const outgoing = describeIt(challenge({ status: "PENDING" }), ME, true);
    expect(outgoing).toMatchObject({ tone: "ended", headline: "Call BS with Maria expired", canRespond: false });
    expect(outgoing.detail).toBe("Maria didn't answer before picks locked.");
    const incoming = describeIt(challenge({ status: "PENDING", challengerUserId: THEM, recipientUserId: ME }), ME, true);
    expect(incoming).toMatchObject({ tone: "ended", canRespond: false });
    expect(incoming.detail).toBe("You didn't answer before picks locked.");
  });

  it("ACCEPTED shows both sides, says the picks are locked and the final score decides", () => {
    const v = describeIt(challenge({ status: "ACCEPTED" }));
    expect(v.tone).toBe("locked");
    expect(v.headline).toBe("Call BS accepted: you vs Maria");
    expect(v.detail).toContain("You picked Chiefs. Maria picked Bills.");
    expect(v.detail).toContain("Both picks are locked");
    expect(v.detail).toContain("final score decides");
  });

  it("RESOLVED names a clear winner from either side's point of view", () => {
    const iWonAsChallenger = describeIt(challenge({ status: "RESOLVED", result: "CHALLENGER_WON" }));
    expect(iWonAsChallenger).toMatchObject({ tone: "won", outcome: "WON", headline: "You called BS on Maria: you were right" });
    const iLostAsChallenger = describeIt(challenge({ status: "RESOLVED", result: "RECIPIENT_WON" }));
    expect(iLostAsChallenger).toMatchObject({ tone: "lost", outcome: "LOST", headline: "You called BS on Maria: Maria was right" });

    const asRecipient = { challengerUserId: THEM, recipientUserId: ME, challengerSelectionSnapshot: "NO", recipientSelectionSnapshot: "YES" } as const;
    const iWonAsRecipient = describeIt(challenge({ status: "RESOLVED", result: "RECIPIENT_WON", ...asRecipient }));
    expect(iWonAsRecipient).toMatchObject({ tone: "won", outcome: "WON", headline: "Maria called BS on you: you were right" });
    const iLostAsRecipient = describeIt(challenge({ status: "RESOLVED", result: "CHALLENGER_WON", ...asRecipient }));
    expect(iLostAsRecipient).toMatchObject({ tone: "lost", outcome: "LOST", headline: "Maria called BS on you: Maria was right" });
  });

  it("a VOID result names no winner", () => {
    const v = describeIt(challenge({ status: "RESOLVED", result: "VOID" }));
    expect(v).toMatchObject({ tone: "void", outcome: "VOID", headline: "Call BS with Maria void" });
    expect(v.detail).toContain("nobody wins");
    expect(`${v.headline} ${v.detail}`).not.toMatch(/won|right|beat/i);
  });

  it("DECLINED reads from each side without implying a penalty", () => {
    expect(describeIt(challenge({ status: "DECLINED" })).headline).toBe("Maria declined your Call BS");
    expect(describeIt(challenge({ status: "DECLINED", challengerUserId: THEM, recipientUserId: ME })).headline).toBe("You declined Maria's Call BS");
    expect(describeIt(challenge({ status: "DECLINED" })).detail).toBe("Nothing was locked.");
  });

  it("EXPIRED / PICK_CHANGED says a pick changed", () => {
    const v = describeIt(challenge({ status: "EXPIRED", expiryReason: "PICK_CHANGED" }));
    expect(v).toMatchObject({ tone: "ended", headline: "Call BS with Maria cancelled" });
    expect(v.detail).toContain("A pick changed");
  });

  it("EXPIRED / NO_RESPONSE and every other expiry are explained without blaming anyone for a system reason", () => {
    expect(describeIt(challenge({ status: "EXPIRED", expiryReason: "NO_RESPONSE" })).headline).toBe("Call BS with Maria expired");
    for (const reason of ["COMPETING_CHALLENGE_RESOLVED", "SYSTEM_INVALIDATED", "GAME_OR_MARKET_CANCELLED", "RELATIONSHIP_BLOCKED", "ACCOUNT_STATE_CHANGE", "OTHER_SYSTEM_REASON"] as const) {
      const v = describeIt(challenge({ status: "EXPIRED", expiryReason: reason }));
      expect(v.headline).toBe("Call BS with Maria is no longer available");
      expect(v.detail).toBe("It ended before it could be accepted. Nothing was locked.");
    }
  });

  it("no state mentions money", () => {
    const all: Challenge[] = [
      challenge({ status: "PENDING" }),
      challenge({ status: "ACCEPTED" }),
      challenge({ status: "RESOLVED", result: "CHALLENGER_WON" }),
      challenge({ status: "RESOLVED", result: "VOID" }),
      challenge({ status: "DECLINED" }),
      challenge({ status: "EXPIRED", expiryReason: "PICK_CHANGED" }),
    ];
    for (const c of all) {
      const v = describeIt(c);
      expect(`${v.headline} ${v.detail}`).not.toMatch(/\b(bet|wager|stake|cash|odds|payout|money|prize|\$)\b/i);
    }
  });
});

describe("challengeOutcomeForViewer", () => {
  it("is decided from the stored winner only", () => {
    expect(challengeOutcomeForViewer({ challengerUserId: ME, result: "CHALLENGER_WON" }, ME)).toBe("WON");
    expect(challengeOutcomeForViewer({ challengerUserId: ME, result: "CHALLENGER_WON" }, THEM)).toBe("LOST");
    expect(challengeOutcomeForViewer({ challengerUserId: ME, result: "RECIPIENT_WON" }, THEM)).toBe("WON");
    expect(challengeOutcomeForViewer({ challengerUserId: ME, result: "VOID" }, ME)).toBe("VOID");
    expect(challengeOutcomeForViewer({ challengerUserId: ME, result: null }, ME)).toBe("VOID");
  });
});

describe("sortChallengeViews", () => {
  it("puts what needs an answer first, then locked, waiting, decided, ended; newest first within a group", () => {
    const mk = (id: string, c: Partial<Challenge> & { status: ChallengeStatus }, pastCutoff = false) => ({
      challenge: challenge({ id, ...c }),
      view: describeIt(challenge({ id, ...c }), ME, pastCutoff),
    });
    const sorted = sortChallengeViews([
      mk("ended", { status: "DECLINED" }),
      mk("waiting", { status: "PENDING", updatedAt: "2026-01-02T00:00:00Z" }),
      mk("won", { status: "RESOLVED", result: "CHALLENGER_WON" }),
      mk("locked", { status: "ACCEPTED" }),
      mk("incoming", { status: "PENDING", challengerUserId: THEM, recipientUserId: ME }),
      mk("waiting-older", { status: "PENDING", updatedAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(sorted.map((s) => s.challenge.id)).toEqual(["incoming", "locked", "waiting", "waiting-older", "won", "ended"]);
  });
});
