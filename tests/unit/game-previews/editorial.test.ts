import { describe, expect, it } from "vitest";
import { angleBasis, chooseAngle, completeAngleFacts, dedupeAngles, overallScore, validateAngles, validateEditorial } from "@/lib/game-previews/editorial";
import type { AngleScores, EditorialAngle } from "@/lib/game-previews/providers/types";
import { angles, config, facts, goodDraft, selection } from "./fixtures";

const s = (n: number): AngleScores => ({ tension: n, surprise: n, specificity: n, humanInterest: n, conversation: n, recency: n });
const angle = (over: Partial<EditorialAngle> = {}): EditorialAngle => ({ ...angles[0], ...over });
const findings = (draft = goodDraft, a = angles[0], c = config) => validateEditorial({ draft, angle: a, config: c, facts });
const blocking = (draft = goodDraft, a = angles[0], c = config) => findings(draft, a, c).blocking;
const advisory = (draft = goodDraft, a = angles[0], c = config) => findings(draft, a, c).advisory;

describe("candidate angles", () => {
  it("accepts 3-5 well-formed angles that cite real facts and select one of them", () => {
    expect(validateAngles(selection, facts)).toEqual([]);
  });

  it("rejects the wrong number of angles, unknown types, unknown facts, out-of-range scores, empty facts and a selection that is not a candidate", () => {
    expect(validateAngles({ angles: angles.slice(0, 2), selectedId: "a1" }, facts).join(" ")).toMatch(/3 to 5/);
    expect(validateAngles({ angles: [angle({ type: "NOT_A_TYPE" as never }), angles[1], angles[2]], selectedId: "a1" }, facts).join(" ")).toMatch(/unknown type/);
    expect(validateAngles({ angles: [angle({ factIds: ["f99"] }), angles[1], angles[2]], selectedId: "a1" }, facts).join(" ")).toMatch(/not a researched fact/);
    expect(validateAngles({ angles: [angle({ factIds: [] }), angles[1], angles[2]], selectedId: "a1" }, facts).join(" ")).toMatch(/uses no facts/);
    expect(validateAngles({ angles: [angle({ scores: { ...s(3), tension: 9 } }), angles[1], angles[2]], selectedId: "a1" }, facts).join(" ")).toMatch(/invalid tension/);
    expect(validateAngles({ angles, selectedId: "zzz" }, facts).join(" ")).toMatch(/not one of the candidates/);
    expect(validateAngles({ angles: [angles[0], angles[0], angles[2]], selectedId: "a1" }, facts).join(" ")).toMatch(/repeated/);
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

describe("editorial validation — BLOCKING is wrong or misleading; ADVISORY is taste", () => {
  it("accepts a draft that tells the chosen story with the facts it needs: nothing blocking, nothing advisory", () => {
    expect(findings()).toEqual({ blocking: [], advisory: [] });
  });

  it("BLOCKS facts outside the chosen story, and more facts than one story may cite (configurable)", () => {
    expect(blocking(goodDraft, angle({ factIds: ["f1"] })).join(" ")).toMatch(/outside the chosen story/);
    expect(blocking(goodDraft, angles[0], { ...config, maxCitedFacts: 2 }).join(" ")).toMatch(/cites 3 facts.*at most 2/);
  });

  it("BLOCKS sportsbook language and a time of day (no fact gives one)", () => {
    expect(blocking({ ...goodDraft, preview: `${goodDraft.preview} The Colts are heavy favorites on the moneyline.` }).join(" ")).toMatch(/Sportsbook language/);
    expect(blocking({ ...goodDraft, preview: `${goodDraft.preview} Tonight it ends.` }).join(" ")).toMatch(/time of day/);
  });

  it("a hook that states a record or score is ADVISORY: noted, never a rejection", () => {
    const f = findings({ ...goodDraft, hook: "Tennessee is 0-5, Indianapolis is 2-3" });
    expect(f.advisory.join(" ")).toMatch(/states a record or score/);
    expect(f.blocking).toEqual([]);
  });

  it("a hook with two figures is fine ('Two games. Six goals.'); three or more reads as metadata (advisory)", () => {
    expect(advisory({ ...goodDraft, hook: "Wembanyama had 22 points in Game 7. Holmgren had four." })).toEqual([]);
    expect(advisory({ ...goodDraft, hook: "Zero wins in 5 games, 3 straight blowouts, 41 points allowed" }).join(" ")).toMatch(/made of figures/);
  });

  it("a statistics dump is ADVISORY", () => {
    const dump = "Tennessee is 0-5 with scores of 10, 20, 7, 18 and 3. Indianapolis is 2-3 after 23, 30, 19, 30 and 22 points and beat Tennessee 41-20 and 38-14, 26-3, 34-22.";
    const f = findings({ ...goodDraft, preview: dump }, angles[0], { ...config, maxCitedFacts: 3 });
    expect(f.advisory.join(" ")).toMatch(/list of statistics/);
    expect(f.blocking.join(" ")).not.toMatch(/list of statistics/);
  });

  it("generic filler is ADVISORY", () => {
    for (const filler of ["Both teams are looking for a win.", "This should be an exciting matchup.", "It promises to be a great game.", "A battle between two struggling teams."]) {
      const f = findings({ ...goodDraft, preview: `${goodDraft.preview} ${filler}` });
      expect(f.advisory.join(" "), filler).toMatch(/Generic phrasing/);
      expect(f.blocking.join(" "), filler).not.toMatch(/Generic phrasing/);
    }
  });

  it("a stock closing question and a preview that repeats the hook are ADVISORY; a question that is part of the story is fine", () => {
    expect(advisory({ ...goodDraft, preview: "Tennessee is 0-5 after a 26-3 loss to Houston. Who will win?" }).join(" ")).toMatch(/stock question/);
    expect(advisory().join(" ")).not.toMatch(/stock question/);
    expect(advisory({ ...goodDraft, preview: `${goodDraft.hook} and nothing more` }).join(" ")).toMatch(/repeats the hook/);
  });

  it("the draft must rest on the story's primary fact (the one the Preview credits)", () => {
    expect(blocking({ ...goodDraft, claims: goodDraft.claims.filter((c) => !c.factIds.includes("f1")) }).join(" ")).toMatch(/primary fact \(f1\)/);
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

  it("history does not need a label merely because it happened before today: a claim on earlier-season facts is not blocked for lacking one (the independent read judges genuine ambiguity)", () => {
    const base = goodDraft.claims.filter((c) => !c.factIds.includes("f2"));
    const draftWith = (text: string) => ({ ...goodDraft, claims: [...base, { text, factIds: ["f2"] }] });
    expect(blocking(draftWith("Indianapolis beat Tennessee 41-20 and 38-14 last season."))).toEqual([]);
    expect(blocking(draftWith("Indianapolis beat Tennessee 41-20 and 38-14."))).toEqual([]);
  });

  it("but an earlier-season fact worded as THIS season's form still blocks", () => {
    const base = goodDraft.claims.filter((c) => !c.factIds.includes("f2"));
    const draftWith = (text: string) => ({ ...goodDraft, claims: [...base, { text, factIds: ["f2"] }] });
    expect(blocking(draftWith("Indianapolis has currently beaten Tennessee 41-20 and 38-14.")).join(" ")).toMatch(/worded as this season's/);
  });

  it("a claim with at least one current-season fact is not held to that wording rule", () => {
    const d = { ...goodDraft, claims: [...goodDraft.claims, { text: "Tennessee is 0-5 and currently lost twice by 20 or more last year.", factIds: ["f1", "f2"] }] };
    expect(blocking(d).filter((p) => /earlier-season/.test(p))).toEqual([]);
  });
});

describe("no time of day", () => {
  it("rejects 'tonight' and 'this afternoon': the research gives no local time", () => {
    expect(blocking({ ...goodDraft, preview: `${goodDraft.preview} Tonight it ends.` }).join(" ")).toMatch(/time of day/);
    expect(blocking({ ...goodDraft, hook: "This afternoon, Indianapolis answers." }).join(" ")).toMatch(/time of day/);
    expect(blocking({ ...goodDraft, preview: `${goodDraft.preview} Today it ends.` }).join(" ")).not.toMatch(/time of day/);
  });
});

describe("an earlier season's playoffs are not named by the new season's year", () => {
  // The fixture Game is in October 2026: the 2026 season is just starting, so "the 2026 playoffs" were last spring but read as this season's.
  const kickoffUtc = "2026-10-18T17:00:00.000Z";
  const base = goodDraft.claims.filter((c) => !c.factIds.includes("f2"));
  const withClaim = (text: string, preview = text) => ({ ...goodDraft, preview: `${goodDraft.preview} ${preview}`, claims: [...base, { text, factIds: ["f2"] }] });
  const run = (d: typeof goodDraft) => validateEditorial({ draft: d, angle: angles[0], config, facts, kickoffUtc }).blocking;

  it("rejects 'the 2026 playoffs' in an October 2026 Game", () => {
    expect(run(withClaim("New York swept Philadelphia in the 2026 playoffs.")).join(" ")).toMatch(/ambiguous/);
  });

  it("accepts the season label ('the 2025-26 playoffs') as ESPN prints it", () => {
    expect(run(withClaim("New York swept Philadelphia in the 2025-26 playoffs.")).filter((p) => /ambiguous/.test(p))).toEqual([]);
  });

  it("accepts 'last season' and an earlier calendar year", () => {
    expect(run(withClaim("Indianapolis beat Tennessee 41-20 and 38-14 last season.")).filter((p) => /ambiguous/.test(p))).toEqual([]);
    expect(run(withClaim("Indianapolis beat Tennessee 41-20 and 38-14 in 2025.")).filter((p) => /ambiguous/.test(p))).toEqual([]);
  });

  it("a Game from the first half of a year does not trip the rule (that year's playoffs are the current season's)", () => {
    const d = withClaim("Indianapolis beat Tennessee 41-20 and 38-14 last season, and the 2027 playoffs loom.");
    expect(validateEditorial({ draft: d, angle: angles[0], config, facts, kickoffUtc: "2027-03-02T17:00:00.000Z" }).blocking.filter((p) => /ambiguous/.test(p))).toEqual([]);
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
    expect(validateAngles(selection, facts)).toEqual([]);
  });
});
