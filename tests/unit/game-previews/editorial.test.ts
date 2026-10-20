import { describe, expect, it } from "vitest";
import { angleBasis, chooseAngle, completeAngleFacts, dedupeAngles, orderAnglePrimary, overallScore, sanitizeAngles, validateEditorial } from "@/lib/game-previews/editorial";
import type { AngleScores, EditorialAngle } from "@/lib/game-previews/providers/types";
import { angles, config, facts, goodDraft, selection } from "./fixtures";

const s = (n: number): AngleScores => ({ tension: n, surprise: n, specificity: n, humanInterest: n, conversation: n, recency: n });
const angle = (over: Partial<EditorialAngle> = {}): EditorialAngle => ({ ...angles[0], ...over });
const findings = (draft = goodDraft, a = angles[0], c = config) => validateEditorial({ draft, angle: a, config: c, facts });
const blocking = (draft = goodDraft, a = angles[0], c = config) => findings(draft, a, c).blocking;

describe("candidate angles: structural clean-up only, no 3-5 requirement", () => {
  it("keeps well-formed angles untouched", () => {
    const r = sanitizeAngles(selection, facts);
    expect(r.problems).toEqual([]);
    expect(r.selection.angles).toHaveLength(3);
    expect(r.selection.selectedId).toBe("a1");
  });

  it("accepts a single angle (the number of candidates is not a gate)", () => {
    const r = sanitizeAngles({ angles: [angles[0]], selectedId: "a1" }, facts);
    expect(r.problems).toEqual([]);
    expect(r.selection.angles).toHaveLength(1);
  });

  it("repairs what it can: an unknown type becomes CONTRAST, a score is clamped, an unknown fact id is dropped, a bad selection falls back to the best angle", () => {
    const r = sanitizeAngles({ angles: [angle({ type: "NOT_A_TYPE" as never, scores: { ...s(3), tension: 9 }, factIds: ["f1", "f99"] }), angles[1]], selectedId: "zzz" }, facts);
    expect(r.selection.angles[0].type).toBe("CONTRAST");
    expect(r.selection.angles[0].scores.tension).toBe(5);
    expect(r.selection.angles[0].factIds).toEqual(["f1"]);
    expect(r.selection.angles.map((x) => x.id)).toContain(r.selection.selectedId);
  });

  it("drops an angle that cites no known fact, and reports a problem only when nothing usable is left", () => {
    expect(sanitizeAngles({ angles: [angle({ factIds: ["f99"] }), angles[1]], selectedId: "a1" }, facts).selection.angles.map((x) => x.id)).toEqual(["a2"]);
    expect(sanitizeAngles({ angles: [angle({ factIds: [] })], selectedId: "a1" }, facts).problems.join(" ")).toMatch(/no usable/i);
  });

  it("scores an angle as the mean of the six criteria", () => {
    expect(overallScore({ tension: 5, surprise: 3, specificity: 4, humanInterest: 2, conversation: 3, recency: 3 })).toBe(3.3333333333333335);
  });
});

describe("choosing the story: records are fallback material", () => {
  it("keeps the model's choice when it is a real story", () => {
    const c = chooseAngle(selection, 3, facts);
    expect(c.angle.id).toBe("a1");
    expect(c.overridden).toBe(false);
  });

  it("overrides a records-only choice when a story scoring at least the configured minimum exists", () => {
    const c = chooseAngle({ ...selection, selectedId: "a2", selectionReason: "simple" }, 3, facts);
    expect(c.overridden).toBe(true);
    expect(c.angle.id).toBe("a1"); // the best real story, not just any
    expect(c.reason).toMatch(/records-only angle was set aside/);
  });

  it("the minimum is configuration: a stricter bar leaves the fallback standing when no story clears it", () => {
    expect(chooseAngle({ ...selection, selectedId: "a2", selectionReason: "x" }, 4.5, facts).overridden).toBe(false);
    expect(chooseAngle({ ...selection, selectedId: "a2", selectionReason: "x" }, 4.5, facts).angle.id).toBe("a2");
  });
});

describe("editorial validation: BLOCKING is the credited source; ADVISORY is guidance", () => {
  it("accepts a draft that tells the chosen story with the facts it needs: nothing blocking, nothing advisory", () => {
    expect(findings()).toEqual({ blocking: [], advisory: [] });
  });

  it("the draft must rest on the story's primary fact (the one the Preview credits)", () => {
    expect(blocking({ ...goodDraft, claims: goodDraft.claims.filter((c) => !c.factIds.includes("f1")) }).join(" ")).toMatch(/primary fact \(f1\)/);
  });

  it("citing more facts than the configured guidance is ADVISORY, never blocking", () => {
    const f = findings(goodDraft, angles[0], { ...config, maxCitedFacts: 2 });
    expect(f.advisory.join(" ")).toMatch(/cites 3 facts.*at most 2/);
    expect(f.blocking).toEqual([]);
  });

  it("(test N) taste and wording are not decided by code: records in the title, stat-heavy text, filler and stock questions raise nothing", () => {
    for (const d of [
      { ...goodDraft, hook: "Tennessee is 0-5, Indianapolis is 2-3" },
      { ...goodDraft, hook: "Zero wins in 5 games, 3 straight blowouts, 41 points allowed" },
      { ...goodDraft, preview: `${goodDraft.preview} This should be an exciting matchup. Who will win?` },
      { ...goodDraft, preview: `${goodDraft.hook} and nothing more` },
      { ...goodDraft, preview: `${goodDraft.preview} Tonight it ends.` },
    ]) expect(findings(d)).toEqual({ blocking: [], advisory: [] });
  });
});

describe("completeAngleFacts — the story line may not carry a figure its facts do not hold", () => {
  it("adds the pool fact that holds a figure named in the summary", () => {
    const a = angle({ summary: "Indianapolis beat Tennessee 41-20 last year.", factIds: ["f1"] });
    const r = completeAngleFacts(a, facts);
    expect(r.added).toEqual(["f2"]);
    expect(r.angle.factIds).toEqual(["f1", "f2"]);
    expect(r.unresolved).toEqual([]);
  });

  it("changes nothing when the listed facts already hold every figure, and reports a figure no fact holds", () => {
    const covered = completeAngleFacts(angle({ summary: "Tennessee fell to 0-5 after a 26-3 loss.", factIds: ["f1"] }), facts);
    expect(covered.added).toEqual([]);
    expect(covered.angle.factIds).toEqual(["f1"]);
    const unknown = completeAngleFacts(angle({ summary: "Tennessee has lost 99 straight.", factIds: ["f1"] }), facts);
    expect(unknown.unresolved).toEqual(["99"]);
    expect(unknown.angle.factIds).toEqual(["f1"]);
  });
});

describe("current season first, history as support (never ambiguous)", () => {
  it("computes what an angle rests on from its facts: this season, this season with history, or history alone", () => {
    expect(angleBasis({ factIds: ["f1", "f3"] }, facts)).toBe("CURRENT_SEASON");
    expect(angleBasis({ factIds: ["f1", "f2"] }, facts)).toBe("CURRENT_WITH_HISTORY");
    expect(angleBasis({ factIds: ["f2"] }, facts)).toBe("HISTORY_ONLY");
  });

  it("a history-only story is set aside for a current-season story that clears the minimum", () => {
    const sel = { ...selection, selectedId: "a3", selectionReason: "history" };
    const c = chooseAngle(sel, 3, facts);
    expect(c.overridden).toBe(true);
    expect(c.angle.id).toBe("a1");
    expect(c.reason).toMatch(/history-only angle was set aside/);
  });

  it("history may carry the Game when no current-season story clears the minimum", () => {
    const weak = { ...selection, angles: selection.angles.map((a) => (a.id === "a3" ? a : { ...a, scores: s(2) })), selectedId: "a3", selectionReason: "history" };
    const c = chooseAngle(weak, 3, facts);
    expect(c.overridden).toBe(false);
    expect(c.angle.id).toBe("a3");
  });

});

describe("genuinely different angles — duplicates are set aside, never a reason to reject the run", () => {
  it("keeps the stronger of two angles on the same facts, and of two angles of the same kind; records what was dropped", () => {
    const sameFacts = { ...selection, angles: [angles[0], { ...angles[1], type: "STREAK_ON_THE_LINE" as const, factIds: ["f1", "f3", "f2"], scores: s(2) }, angles[2]] };
    const r1 = dedupeAngles(sameFacts);
    expect(r1.selection.angles.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(r1.dropped).toEqual([{ id: "a2", keptId: "a1", reason: "rests on the same facts as a stronger angle" }]);
    const twice = { ...selection, angles: [angles[0], { ...angles[1], type: "CONTRAST" as const, factIds: ["f1"], scores: s(2) }, angles[2]] };
    const r2 = dedupeAngles(twice);
    expect(r2.dropped).toEqual([{ id: "a2", keptId: "a1", reason: "is another CONTRAST story; the stronger one was kept" }]);
  });
  it("two injury stories for a Game whose news is mostly injuries: the stronger stays, the run goes on", () => {
    const inj = (id: string, fact: string, n: number) => ({ ...angles[0], id, type: "INJURY_RETURN" as const, factIds: [fact], scores: s(n) });
    const r = dedupeAngles({ angles: [inj("a1", "f1", 3), inj("a2", "f3", 4), { ...angles[2], id: "a3" }], selectedId: "a1" });
    expect(r.selection.angles.map((a) => a.id)).toEqual(["a2", "a3"]);
    expect(r.selection.selectedId).toBe("a2"); // the selected angle was the weaker twin: its kept twin takes its place
  });
  it("leaves angles of different kinds on different facts untouched", () => {
    const r = dedupeAngles(selection);
    expect(r.selection.angles).toEqual(selection.angles);
    expect(r.dropped).toEqual([]);
    expect(sanitizeAngles(selection, facts).problems).toEqual([]);
  });
});

describe("orderAnglePrimary — the credited source is chosen among the story's own facts", () => {
  const ok = () => true;
  it("keeps the first fact when it is eligible and current", () => {
    expect(orderAnglePrimary(angles[0], facts, ok)).toBe(angles[0]);
  });
  it("re-points to the first eligible fact when the first-listed one is not (the story is not lost)", () => {
    const r = orderAnglePrimary(angles[0], facts, (f) => f.id !== "f1")!;
    expect(r.factIds).toEqual(["f3", "f1", "f2"]); // f2 is history, so the first eligible CURRENT fact (f3) leads
  });
  it("a story about this season never credits an earlier-season article, even if it is listed first and eligible", () => {
    const hist = { ...angles[0], factIds: ["f2", "f1"], centralFactIds: ["f2", "f1"] }; // f2 is HISTORICAL_CONTEXT, f1 is this season
    expect(orderAnglePrimary(hist, facts, ok)!.factIds).toEqual(["f1", "f2"]);
  });
  it("returns null when no fact of the story can be credited: a current story whose only current facts are ineligible, or no eligible fact at all", () => {
    expect(orderAnglePrimary(angles[0], facts, (f) => f.id === "f2")).toBeNull(); // only the historical fact is eligible: not a credit for a current story
    expect(orderAnglePrimary(angles[0], facts, () => false)).toBeNull();
  });
  it("(test A) the public primary is chosen among the CENTRAL facts only: an eligible source for an incidental fact is not the credit", () => {
    const story = { ...angles[0], factIds: ["f1", "f2", "f3"], centralFactIds: ["f1"] };
    expect(orderAnglePrimary(story, facts, (f) => f.id === "f1")!.factIds[0]).toBe("f1");
    expect(orderAnglePrimary(story, facts, (f) => f.id === "f3")).toBeNull(); // f3 is eligible but incidental: the story has no creditable source for its central claim
    expect(orderAnglePrimary({ ...story, centralFactIds: undefined }, facts, (f) => f.id === "f3")).toBeNull(); // no central list: the first fact is the central one
  });
  it("a history-only story may be credited to a historical source", () => {
    expect(orderAnglePrimary(angles[2], facts, ok)!.factIds).toEqual(["f2"]);
  });
});
