/** Deterministic claim verification in isolation: each rule has a positive and a negative case. */
import { describe, expect, it } from "vitest";
import { findUnclaimedFacts, verifyClaimDeterministic } from "@/lib/game-stories/claims";
import { claim, config, ev, game, hoursAgo, NOW, structuredEv } from "../../support/game-stories";

const ctx = { game: game(), config: config(), now: NOW };
const check = (c: ReturnType<typeof claim>, items: ReturnType<typeof ev>[]) => verifyClaimDeterministic(c, new Map(items.map((e) => [e.id, e])), ctx);

describe("verifyClaimDeterministic", () => {
  it("a superseded source cannot support a claim (STALE)", () => {
    const e = ev({ status: "SUPERSEDED", statusReason: "a_newer_source_reports_a_different_value" });
    const r = check(claim({ text: "Boston is rested", evidenceIds: [e.id] }), [e]);
    expect(r).toMatchObject({ verdict: "STALE", code: "STALE_EVIDENCE" });
  });
  it("a conflicted source is CONTRADICTED", () => {
    const e = ev({ status: "CONFLICTED" });
    expect(check(claim({ text: "x", evidenceIds: [e.id] }), [e])).toMatchObject({ verdict: "CONTRADICTED", code: "CONTRADICTED_CLAIM" });
  });
  it("a quarantined (suspicious) source can never support a claim", () => {
    const e = ev({ status: "SUSPICIOUS" });
    expect(check(claim({ text: "x", evidenceIds: [e.id] }), [e]).code).toBe("UNSUPPORTED_CLAIM");
  });
  it("accepts figures that appear in the evidence as number words or digits, and ignores digits inside team names", () => {
    const e = structuredEv({ factText: "The San Francisco 49ers have won 3 straight games." });
    const g = game({ homeTeam: "San Francisco 49ers", awayTeam: "Dallas Cowboys" });
    const r = verifyClaimDeterministic(claim({ text: "The San Francisco 49ers have won three straight games", type: "STREAK", subjectTeam: "BOTH", evidenceIds: [e.id] }), new Map([[e.id, e]]), { ...ctx, game: g });
    expect(r.verdict).toBe("SUPPORTED");
  });
  it("a current-type claim on evidence older than the configured window is STALE; historical context of any age is not", () => {
    const old = ev({ publishedAt: hoursAgo(24 * 20) });
    expect(check(claim({ text: "Boston is playing well", type: "STREAK", evidenceIds: [old.id] }), [old]).verdict).toBe("STALE");
    expect(check(claim({ text: "Boston beat New York in the playoffs", type: "HISTORY", evidenceIds: [old.id] }), [old]).verdict).toBe("SUPPORTED");
  });
  it("an availability claim without a stated status is AMBIGUOUS", () => {
    const e = ev({ factValue: "OUT" });
    expect(check(claim({ text: "He is hurt", type: "AVAILABILITY", subjectTeam: "AWAY", evidenceIds: [e.id] }), [e]).verdict).toBe("AMBIGUOUS");
  });
  it("evidence that is about neither team cannot support a claim about a team", () => {
    const e = ev({ subjectTeam: "NEITHER" });
    expect(check(claim({ text: "Boston is rested", subjectTeam: "HOME", evidenceIds: [e.id] }), [e]).code).toBe("IDENTITY_MISMATCH");
  });
});

describe("findUnclaimedFacts", () => {
  const g = game();
  it("is empty when every figure and name in the copy is in a claim", () => {
    const c = [claim({ text: "Jalen Brunson is out with an ankle injury", evidenceIds: ["x"] })];
    expect(findUnclaimedFacts("Brunson sits.", "Boston hosts New York without Jalen Brunson.", c, g)).toEqual([]);
  });
  it("flags a number or a name that no claim covers", () => {
    const c = [claim({ text: "Jalen Brunson is out", evidenceIds: ["x"] })];
    const out = findUnclaimedFacts("Brunson sits.", "Boston hosts New York; Derrick White has played 12 minutes of it.", c, g);
    expect(out).toEqual(expect.arrayContaining(["12", "White"]));
  });
  it("a team's short form and the Game's own weekday are not facts; any other weekday is (found on real runs: 'Philly', 'Monday')", () => {
    const eagles = { homeTeam: "Philadelphia Eagles", awayTeam: "Dallas Cowboys", kickoffUtc: "2026-10-27T00:15:00Z" }; // a Monday-evening US Game, Tuesday in UTC
    const c = [claim({ text: "Dallas has lost two straight", evidenceIds: ["x"] })];
    expect(findUnclaimedFacts("Without Hurts.", "Dallas visits Philly on Monday; somebody's offense wakes up Tuesday.", c, eagles)).toEqual(["Hurts"]);
    expect(findUnclaimedFacts("Quiet night.", "Dallas visits Philly. They lost last Thursday.", c, eagles)).toEqual(["Thursday"]);
  });
  it("does not treat the first word of a sentence, team names or 'one' as facts", () => {
    const c = [claim({ text: "Boston hosts New York", evidenceIds: ["x"] })];
    expect(findUnclaimedFacts("Tonight it matters.", "Boston and the Knicks meet. One of them blinks first.", c, g)).toEqual([]);
  });
});
