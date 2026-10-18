import { describe, expect, it } from "vitest";
import { domainMatches, domainOf, numbersIn, reconcileSeasonScope, splitUsableFacts, validateDraft } from "@/lib/game-previews/validation";
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

describe("splitUsableFacts — a current-state fact needs a dated, recent source before the angle or writer may see it", () => {
  const current = (over = {}) => fact({ id: "c1", kind: "current", category: "injury", claim: "The quarterback practiced in full.", ...over });

  it("keeps history (no expiry) and a recently dated current fact", () => {
    const recent = current({ publishedAt: "2026-10-16T00:00:00.000Z" });
    const { usable, excluded } = splitUsableFacts([...facts, recent], config, NOW);
    expect(usable.map((f) => f.id)).toEqual(["f1", "f2", "f3", "c1"]);
    expect(excluded).toEqual([]);
  });

  it("sets aside a current fact with no publication time, an unreadable one, or one older than the window — with the reason", () => {
    const undated = current({ id: "c2", publishedAt: null });
    const junk = current({ id: "c3", publishedAt: "not a date" });
    const stale = current({ id: "c4", publishedAt: "2026-10-10T00:00:00.000Z" });
    const { usable, excluded } = splitUsableFacts([...facts, undated, junk, stale], config, NOW);
    expect(usable.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(excluded.map((e) => e.fact.id)).toEqual(["c2", "c3", "c4"]);
    expect(excluded[0].reason).toMatch(/no publication time/);
    expect(excluded[2].reason).toMatch(/older than 72 hours/);
  });

  it("an old statement of HISTORY is never set aside for its age", () => {
    const old = fact({ id: "h1", kind: "historical", publishedAt: "2025-12-14T00:00:00.000Z" });
    expect(splitUsableFacts([old], config, NOW).usable).toHaveLength(1);
  });
});

describe("reconcileSeasonScope — an earlier season is never current form", () => {
  const g = { kickoffUtc: "2026-10-18T17:00:00.000Z" };
  it("moves a fact that names an earlier season, or says 'last season', to HISTORICAL_CONTEXT", () => {
    const out = reconcileSeasonScope([fact({ id: "a", claim: "The Chargers swept the Chiefs in 2025." }), fact({ id: "b", claim: "Kansas City lost both meetings last season." }), fact({ id: "c", claim: "Tennessee lost 26-3 on Oct. 11." })], g);
    expect(out.map((f) => f.seasonScope)).toEqual(["HISTORICAL_CONTEXT", "HISTORICAL_CONTEXT", "CURRENT_SEASON"]);
  });
  it("only ever demotes: history stays history, and a current-state fact is this season's", () => {
    expect(reconcileSeasonScope([fact({ seasonScope: "HISTORICAL_CONTEXT", claim: "Tennessee is 0-5." })], g)[0].seasonScope).toBe("HISTORICAL_CONTEXT");
    expect(reconcileSeasonScope([fact({ kind: "current", seasonScope: "HISTORICAL_CONTEXT", claim: "Out since 2025 surgery." })], g)[0].seasonScope).toBe("CURRENT_SEASON");
  });
  it("judges years against the Game's date: in January the previous calendar year can still be this season", () => {
    const jan = { kickoffUtc: "2027-01-10T17:00:00.000Z" };
    expect(reconcileSeasonScope([fact({ claim: "The Chargers lost on Dec. 14, 2026." })], jan)[0].seasonScope).toBe("CURRENT_SEASON");
    expect(reconcileSeasonScope([fact({ claim: "The Chargers won 16-13 in 2025." })], jan)[0].seasonScope).toBe("HISTORICAL_CONTEXT");
  });
});

describe("a time frame is a claim: 'this season' needs a fact that says it", () => {
  const streak = fact({ id: "f9", kind: "historical", claim: "Justin Herbert has thrown at least one interception in six straight games.", excerpt: "one+ interception thrown in six straight games", publishedAt: "2026-10-18T00:00:00.000Z" });
  const withText = (preview: string, claimText: string, f = streak) => ({ hook: "Six straight with a pick.", preview, claims: [{ text: claimText, factIds: [f.id] }] });
  const run = (d: ReturnType<typeof withText>, f = streak) => validateDraft({ draft: d, facts: [f], game, config, now: NOW });

  it("rejects 'six straight games this season' when the fact does not say this season (it may reach into last season)", () => {
    const r = run(withText("Justin Herbert has thrown at least one interception in six straight games this season, and Tennessee at Indianapolis is next.", "Justin Herbert has thrown at least one interception in six straight games this season."));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/says "this season"/);
  });

  it("allows the same wording when the cited fact itself says it", () => {
    const f = { ...streak, claim: "Justin Herbert has thrown at least one interception in six straight games this season." };
    expect(run(withText("Justin Herbert has thrown at least one interception in six straight games this season, and Tennessee at Indianapolis is next.", f.claim, f), f).problems.filter((p) => /this season/.test(p))).toEqual([]);
  });

  it("allows the fact's own time frame to be left out (plain 'six straight games')", () => {
    expect(run(withText("Justin Herbert has thrown at least one interception in six straight games, and Tennessee at Indianapolis is next.", "Justin Herbert has thrown at least one interception in six straight games.")).problems.filter((p) => /this season/.test(p))).toEqual([]);
  });
});
