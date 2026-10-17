import { describe, expect, it } from "vitest";
import { domainMatches, domainOf, numbersIn, validateDraft } from "@/lib/game-previews/validation";
import { config, fact, facts, game, goodDraft, NOW } from "./fixtures";

const check = (draft = goodDraft, f = facts, c = config) => validateDraft({ draft, facts: f, game, config: c, now: NOW });

describe("validateDraft — the gate before a Preview is saved", () => {
  it("accepts a draft whose every claim cites researched facts and whose figures all come from them", () => {
    expect(check()).toEqual({ ok: true, problems: [] });
  });

  it("rejects a figure that is in no cited fact (an invented number cannot be published)", () => {
    const r = check({ ...goodDraft, preview: goodDraft.preview.replace("26-3", "27-3") });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/"27"/);
  });

  it("rejects a spelled-out number or ordinal the facts do not contain", () => {
    expect(check({ ...goodDraft, preview: `${goodDraft.preview} Tennessee has lost seven straight.` }).problems.join(" ")).toMatch(/"7"/);
    expect(check({ ...goodDraft, preview: `${goodDraft.preview} It is their fourth road game.` }).problems.join(" ")).toMatch(/"4"/);
  });

  it("does not treat ordinary words like 'no one' or 'second half' as figures", () => {
    expect(numbersIn("No one expected a second half like that").size).toBe(0);
    expect(check({ ...goodDraft, preview: `${goodDraft.preview} No one saw it coming.` }).ok).toBe(true);
  });

  it("rejects a claim that cites nothing, or cites a fact that was not researched", () => {
    expect(check({ ...goodDraft, claims: [...goodDraft.claims, { text: "Something else.", factIds: [] }] }).problems.join(" ")).toMatch(/cites no fact/);
    expect(check({ ...goodDraft, claims: [{ text: "x", factIds: ["f99"] }] }).problems.join(" ")).toMatch(/not one of the researched facts/);
    expect(check({ ...goodDraft, claims: [] }).problems.join(" ")).toMatch(/no supporting claims/);
  });

  it("rejects text over the CONFIGURED limits (limits are configuration, not constants)", () => {
    expect(check(goodDraft, facts, { ...config, maxChars: 100 }).problems.join(" ")).toMatch(/limit is 100/);
    expect(check(goodDraft, facts, { ...config, hookMaxChars: 20 }).problems.join(" ")).toMatch(/limit is 20/);
    expect(check({ ...goodDraft, hook: " " }).problems.join(" ")).toMatch(/hook is empty/);
  });

  it("rejects a fact from a blocked source, matching subdomains too", () => {
    const social = [fact({ sourceUrl: "https://old.reddit.com/r/nfl/comments/abc" }), ...facts.slice(1)];
    const r = check(goodDraft, social);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/blocked source \(old\.reddit\.com\)/);
    expect(domainMatches(domainOf("https://www.x.com/a"), ["x.com"])).toBe(true);
    expect(domainMatches(domainOf("https://netflix.com/a"), ["x.com"])).toBe(false);
  });

  it("freshness: a CURRENT claim needs a source published inside the configured window; history may use an older one", () => {
    const staleCurrent = [facts[0], facts[1], { ...facts[2], kind: "current" as const, publishedAt: "2026-10-01T00:00:00.000Z" }];
    expect(check(goodDraft, staleCurrent).problems.join(" ")).toMatch(/older than 72 hours/);
    expect(check(goodDraft, staleCurrent, { ...config, currentFactMaxAgeHours: 24 * 30 }).ok).toBe(true); // the window is configuration
    const undated = [facts[0], facts[1], { ...facts[2], kind: "current" as const, publishedAt: null }];
    expect(check(goodDraft, undated).problems.join(" ")).toMatch(/no publication time/);
    // A fresh CURRENT fact passes, and a record that follows from a completed game is history, whatever its age.
    expect(check(goodDraft, [facts[0], facts[1], { ...facts[2], kind: "current" as const, publishedAt: "2026-10-17T08:00:00.000Z" }]).ok).toBe(true);
    expect(check(goodDraft).ok).toBe(true);
    // A historical fact from years ago is fine.
    const oldHistory = [{ ...facts[0], publishedAt: "2019-01-01T00:00:00.000Z" }, ...facts.slice(1)];
    expect(check(goodDraft, oldHistory).ok).toBe(true);
  });

  it("rejects a preview that is not about this Game (names neither team)", () => {
    const r = check({ ...goodDraft, hook: "Zero wins in five.", preview: "A team is 0-5 after a 26-3 loss. Another is 2-3 after 34-22, and won 41-20 and 38-14 last year." });
    expect(r.problems.join(" ")).toMatch(/does not name either team/);
  });
});
