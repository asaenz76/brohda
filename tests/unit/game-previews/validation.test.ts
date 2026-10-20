import { describe, expect, it } from "vitest";
import { claimedFigures, domainMatches, domainOf, draftHints, isBettingPage, isEligiblePrimarySource, isStoryPage, isTrustedSource, reconcileSeasonScope, styleProblems, unsupportedQuotes, validateDraft, verificationReasons } from "@/lib/game-previews/validation";
import { competitionPhase, currentSeasonStart } from "@/lib/game-previews/identity";
import { config, fact, facts, game, goodDraft, NOW } from "./fixtures";

const check = (draft = goodDraft, f = facts, c = config) => validateDraft({ draft, facts: f, game, config: c, now: NOW });

describe("validateDraft: only what code can decide", () => {
  it("accepts a draft with a title, a caption, claims citing researched facts, and the combined length under the limit", () => {
    expect(check()).toEqual({ ok: true, problems: [] });
  });

  it("(test Q) title + caption TOGETHER must be fewer than the configured limit, counted exactly", () => {
    const total = goodDraft.hook.length + goodDraft.preview.length;
    expect(check(goodDraft, facts, { ...config, maxChars: total + 1 }).ok).toBe(true);
    expect(check(goodDraft, facts, { ...config, maxChars: total }).problems.join(" ")).toMatch(/fewer than/);
    expect(check({ ...goodDraft, hook: "x".repeat(100), preview: "y".repeat(599) }).ok).toBe(true); // 699
    expect(check({ ...goodDraft, hook: "x".repeat(100), preview: "y".repeat(600) }).problems.join(" ")).toMatch(/700/); // 700 is not fewer than 700
  });

  it("there is no separate title-length gate (a 130 character title passes while the combined text fits)", () => {
    expect(check({ ...goodDraft, hook: "x".repeat(130), preview: "Short." }, facts, { ...config, hookMaxChars: 20 }).ok).toBe(true);
  });

  it("rejects a missing title, a missing caption, no claims, a claim that cites nothing or an unknown fact", () => {
    expect(check({ ...goodDraft, hook: " " }).problems.join(" ")).toMatch(/title is empty/);
    expect(check({ ...goodDraft, preview: "" }).problems.join(" ")).toMatch(/caption is empty/);
    expect(check({ ...goodDraft, claims: [] }).problems.join(" ")).toMatch(/no supporting claims/);
    expect(check({ ...goodDraft, claims: [...goodDraft.claims, { text: "Something else.", factIds: [] }] }).problems.join(" ")).toMatch(/cites no fact/);
    expect(check({ ...goodDraft, claims: [{ text: "x", factIds: ["f99"] }] }).problems.join(" ")).toMatch(/not one of the researched facts/);
  });

  it("rejects a fact from a blocked source, matching subdomains too", () => {
    const social = [fact({ sourceUrl: "https://old.reddit.com/r/nfl/comments/abc" }), ...facts.slice(1)];
    const r = check(goodDraft, social);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/blocked source \(old\.reddit\.com\)/);
    expect(domainMatches(domainOf("https://www.x.com/a"), ["x.com"])).toBe(true);
    expect(domainMatches(domainOf("https://netflix.com/a"), ["x.com"])).toBe(false);
  });

  it("(test O) 'first chance' and 'two stars are out' do not block; numbers are judged by the reviewer, not by code", () => {
    const prose = check({ ...goodDraft, preview: `${goodDraft.preview} Two stars are out, and it is his first chance to answer.` });
    expect(prose.ok).toBe(true);
    // An unsupported figure is no longer a code gate (the reviewer judges it); the code only surfaces it as a hint.
    const wrongFigure = { ...goodDraft, preview: goodDraft.preview.replace("26-3", "27-3") };
    expect(check(wrongFigure).ok).toBe(true);
    expect(draftHints(wrongFigure, facts).figures).toContain("27");
  });

  it("(test P) a real figure with no supporting fact ('nine straight wins') is surfaced to the reviewer as a hint", () => {
    const d = { ...goodDraft, preview: `${goodDraft.preview} Indianapolis has won nine straight.` };
    expect(draftHints(d, facts).figures).toContain("9");
    expect(draftHints(goodDraft, facts).figures).toEqual([]);
  });

  it("a time frame ('this season') on a fact that does not say it is a hint, not a gate", () => {
    const f = fact({ id: "f9", claim: "Justin Herbert has thrown at least one interception in six straight games.", excerpt: "one+ interception thrown in six straight games" });
    const d = { hook: "Six straight with a pick.", preview: "Herbert has thrown an interception in six straight games this season.", claims: [{ text: "Herbert has thrown an interception in six straight games this season.", factIds: ["f9"] }] };
    expect(validateDraft({ draft: d, facts: [f], game, config, now: NOW }).ok).toBe(true);
    expect(draftHints(d, [f]).seasonClaims).toHaveLength(1);
    expect(draftHints(d, [{ ...f, claim: `${f.claim} this season` }]).seasonClaims).toEqual([]);
  });

  it("does not require the Preview to name a team (Game identity is the reviewer's wrong_game call)", () => {
    expect(check({ ...goodDraft, hook: "Zero wins in five.", preview: "The city is 0-5 after a 26-3 loss. Can the winless side break through?" }).problems.join(" ")).not.toMatch(/name/);
  });
});

describe("the contract's style invariants are deterministic", () => {
  it("rejects an em dash, a hashtag, wagering language and the banned phrases", () => {
    expect(styleProblems("A big game \u2014 a bigger story.").join(" ")).toMatch(/em dash/);
    expect(styleProblems("Big night #NFL").join(" ")).toMatch(/hashtag/);
    for (const t of ["The odds favor Houston.", "Take the over/under.", "A good bet today.", "Colts -3 point spread"]) expect(styleProblems(t).join(" "), t).toMatch(/wagering/);
    for (const t of ["An epic showdown awaits.", "A must-watch clash in Indy.", "Both teams want the win."]) expect(styleProblems(t).join(" "), t).toMatch(/banned phrase/);
    expect(check({ ...goodDraft, preview: `${goodDraft.preview} An epic showdown.` }).ok).toBe(false);
  });
  it("leaves ordinary sports prose alone ('favorites', 'underdogs', 'better', 'betrayed')", () => {
    expect(styleProblems("The underdogs are the favorites of the locker room. He felt betrayed, and better.")).toEqual([]);
  });
});

describe("(tests B, L, M) season currentness: the supplied season identifier, never the calendar year", () => {
  const nba = { season: "2026-2027", competition: "NBA" };
  it("knows when the season began for the autumn-to-spring leagues from the identifier, and applies no date rule elsewhere", () => {
    expect(currentSeasonStart({ season: "2026", competition: "NFL" })?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(currentSeasonStart(nba)?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(currentSeasonStart({ season: "2026-2027", competition: "NHL" })?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(currentSeasonStart({ season: "2026", competition: "Premier League" })).toBeNull();
    expect(currentSeasonStart({ season: null, competition: "NBA" })).toBeNull();
  });
  it("demotes a 'current-season' fact published before the season began (the Tatum March report in an October Game); never the reverse", () => {
    const out = reconcileSeasonScope([fact({ id: "a", publishedAt: "2026-03-06T00:00:00.000Z" }), fact({ id: "b", publishedAt: "2026-08-11T00:00:00.000Z" }), fact({ id: "c", publishedAt: null }), fact({ id: "d", kind: "current", publishedAt: "2026-03-06T00:00:00.000Z" }), fact({ id: "e", seasonScope: "HISTORICAL_CONTEXT", publishedAt: "2026-10-01T00:00:00.000Z" })], nba);
    expect(out.map((f) => f.seasonScope)).toEqual(["HISTORICAL_CONTEXT", "CURRENT_SEASON", "CURRENT_SEASON", "CURRENT_SEASON", "HISTORICAL_CONTEXT"]);
  });
  it("does NOT infer the season from year words in the claim (a calendar-year regex was removed)", () => {
    const out = reconcileSeasonScope([fact({ claim: "The Chargers lost on Dec. 14, 2026." }), fact({ claim: "Kansas City lost both meetings last season." })], { season: "2026", competition: "NFL" });
    expect(out.map((f) => f.seasonScope)).toEqual(["CURRENT_SEASON", "CURRENT_SEASON"]); // research's own classification stands; the reviewer judges wording
  });
  it("(test M) a stale or undated current-state fact becomes a verification exception instead of being excluded", () => {
    const f = fact({ id: "c1", kind: "current", category: "injury", claim: "The quarterback practiced in full.", publishedAt: "2026-10-01T00:00:00.000Z" });
    const freshness = { now: NOW, currentFactMaxAgeHours: 72 };
    expect(verificationReasons(f, true, freshness).join(" ")).toMatch(/older than 72 hours/);
    expect(verificationReasons({ ...f, publishedAt: null }, true, freshness).join(" ")).toMatch(/no publication date/);
    expect(verificationReasons({ ...f, publishedAt: "2026-10-17T08:00:00.000Z" }, true, freshness)).toEqual([]);
    expect(verificationReasons({ ...f, kind: "historical", publishedAt: "2019-01-01T00:00:00.000Z" }, true, freshness)).toEqual([]); // history never expires
  });
});

describe("competition phase comes from the provider's round label", () => {
  it("separates preseason, regular season and playoffs", () => {
    expect(competitionPhase("Regular Season - Week 6")).toBe("regular_season");
    expect(competitionPhase("Preseason - 2")).toBe("preseason");
    expect(competitionPhase("Playoffs - Conference Finals")).toBe("playoffs");
    expect(competitionPhase("Finals")).toBe("playoffs");
    expect(competitionPhase(null)).toBe("regular_season");
  });
});

describe("story pages: a data endpoint is not a source a member can read", () => {
  it("accepts articles and team pages, rejects JSON/API endpoints", () => {
    expect(isStoryPage("https://www.espn.com/nfl/story/_/id/1/x")).toBe(true);
    expect(isStoryPage("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard")).toBe(false);
    expect(isStoryPage("https://example.com/feed.json")).toBe(false);
  });
});

describe("trusted sources", () => {
  const teams = ["Los Angeles Chargers", "Kansas City Chiefs"];
  const trusted = ["espn.com", "nfl.com", "foxsports.com"];

  it("accepts the stored trusted list (subdomains included) and each team's own website; rejects blogs, farms and aggregators as primary support", () => {
    for (const url of ["https://www.espn.com/nfl/story/1", "https://africa.espn.com/x", "https://www.nfl.com/news/y", "https://www.foxsports.com/stories/z", "https://www.chargers.com/news/injury-report", "https://www.chiefs.com/news/x"]) expect(isTrustedSource(url, teams, trusted), url).toBe(true);
    for (const url of ["https://random-blog.example/post", "https://athlonsports.com/nfl/x", "https://boltsfromtheblue.com/x", "https://nyknicksnews.com/x", "not a url", "https://www.packers.com/news/x"]) expect(isTrustedSource(url, teams, trusted), url).toBe(false);
  });

  it("the trusted list is configuration: an empty list trusts only the team sites", () => {
    expect(isTrustedSource("https://www.espn.com/x", teams, [])).toBe(false);
    expect(isTrustedSource("https://www.espn.com/x", teams, ["espn.com"])).toBe(true);
  });
});

describe("verificationReasons — one trusted source is normally enough", () => {
  it("a trusted source that clearly says it needs no extra verification", () => {
    expect(verificationReasons(fact(), true)).toEqual([]);
  });
  it("the exceptions: untrusted source, disputed, ambiguous, surprising, no passage, a current-season figure on a page that cannot place it", () => {
    expect(verificationReasons(fact(), false)).toEqual(["the source is outside the trusted group"]);
    expect(verificationReasons(fact({ disputed: true }), true)).toEqual(["trusted sources disagree about it"]);
    expect(verificationReasons(fact({ ambiguous: true }), true)).toEqual(["the page is ambiguous about season, date or team"]);
    expect(verificationReasons(fact({ surprising: true }), true)).toEqual(["the claim is unusually surprising or consequential"]);
    expect(verificationReasons(fact({ excerpt: null }), true)).toEqual(["no passage shows that the source says it"]);
    expect(verificationReasons(fact({ sourceType: "profile", publishedAt: null, pageSeason: null }), true)).toEqual(["the page cannot place the figure in the current season"]);
  });
  it("a current-season stats page, or a profile whose page identifies its season, is not an exception", () => {
    expect(verificationReasons(fact({ sourceType: "stats_page", publishedAt: null, pageSeason: null }), true)).toEqual([]);
    expect(verificationReasons(fact({ sourceType: "profile", publishedAt: null, pageSeason: "2026-27" }), true)).toEqual([]);
    expect(verificationReasons(fact({ sourceType: "archive", seasonScope: "HISTORICAL_CONTEXT", publishedAt: null }), true)).toEqual([]); // history needs no season placement
  });
});

describe("no fabricated quotes", () => {
  const cited = [fact({ id: "q", claim: "Embiid said he will be in the locker room.", excerpt: "\"I don't really feel like watching the whole ceremony, so I guess I'll be in the locker room,\" Embiid said." })];
  it("a quote that is word for word in a cited passage passes (case, curly quotes and punctuation aside)", () => {
    expect(unsupportedQuotes("Embiid: \u201Cso I guess I'll be in the locker room\u201D.", cited)).toEqual([]);
  });
  it("a quote that is not in any cited passage is reported", () => {
    expect(unsupportedQuotes('He promised "we will win this game tonight no matter what".', cited)).toEqual(["we will win this game tonight no matter what"]);
  });
  it("scare quotes of one or two words are not quotes", () => {
    expect(unsupportedQuotes('A "sackless" month, a "rough" start.', cited)).toEqual([]);
  });
  it("validateDraft rejects the draft", () => {
    const r = validateDraft({ draft: { ...goodDraft, preview: `${goodDraft.preview} "We will absolutely dominate them" said the coach.` }, facts, game, config, now: NOW });
    expect(r.problems.join(" ")).toMatch(/quote .* is not in any cited source passage/);
  });
});

describe("claimedFigures — figures a draft actually CLAIMS, not every word that can express a number", () => {
  const figs = (t: string) => [...claimedFigures(t)].sort();

  it("ordinary language is not a figure: 'his first chance', 'the first meeting', 'two stars are out', 'the first to arrive', 'the first look'", () => {
    for (const t of ["He gets his first chance to answer.", "It is the first meeting between them.", "Two stars are out for the Rangers.", "Anaheim is not the first to arrive in New York.", "Two teams reshaped this offseason meet in Detroit.", "Who adjusts first?", "Two more are waiting on word.", "A first look at life without Brown."]) expect(figs(t), t).toEqual([]);
  });

  it("factual quantitative claims are figures: 'five straight', '60 wins', 'two touchdowns', 'first in the league', 'ranked third', 'their first win of the season'", () => {
    expect(figs("Carolina has won five straight.")).toEqual(["5"]);
    expect(figs("Detroit won 60 games last season.")).toEqual(["60"]);
    expect(figs("He threw two touchdowns and one interception.")).toEqual(["2"]); // 'one' is left alone (a pronoun far more often than a figure)
    expect(figs("Green Bay is first in the league in interceptions.")).toEqual(["1"]);
    expect(figs("Dallas ranks third in the NFL.")).toEqual(["3"]);
    expect(figs("It was their first win of the season.")).toEqual(["1"]);
    expect(figs("Their fourth road game.")).toEqual(["4"]);
    expect(figs("Ranked 29th in the NFL.")).toEqual(["29"]);
  });

  it("ordinary prose passes validation, and an unsupported claim is flagged as a hint for the reviewer", () => {
    const ok = validateDraft({ draft: { ...goodDraft, preview: "Two stars are out, and it is the first meeting since the trade. Tennessee is 0-5 after a 26-3 loss to Houston." }, facts, game, config, now: NOW });
    expect(ok.ok).toBe(true);
    const bad = { ...goodDraft, preview: "Tennessee has lost seven straight. Tennessee is 0-5 after a 26-3 loss to Houston." };
    expect(draftHints(bad, facts).figures).toContain("7");
  });
});

describe("betting pages are never the credited primary source", () => {
  it("recognises betting, odds, picks and prediction pages by URL or title — even on a trusted domain", () => {
    for (const url of ["https://www.nbcsports.com/betting/nfl/news/49ers-vs-commanders-odds-expert-picks-team-and-player-news", "https://www.espn.com/nfl/odds", "https://www.foxsports.com/nfl/best-bets-week-6", "https://www.cbssports.com/nfl/picks/experts/", "https://www.nfl.com/news/chargers-vs-chiefs-prediction-picks"]) expect(isBettingPage(url), url).toBe(true);
    expect(isBettingPage("https://www.espn.com/nfl/story/_/id/1/chiefs-pass-rush-sackless", "Chiefs still have faith in pass rush")).toBe(false);
    expect(isBettingPage("https://www.nbcsports.com/nfl/news/purdy-leads-49ers", "Purdy leads 49ers")).toBe(false);
    expect(isBettingPage("https://www.espn.com/nfl/story/_/id/2/x", "Chargers vs. Chiefs odds, picks and predictions")).toBe(true); // by title
  });
  it("an eligible primary source is trusted AND not a betting page", () => {
    const teams = ["Washington Commanders", "San Francisco 49ers"];
    const trusted = ["nbcsports.com", "cbssports.com"];
    expect(isEligiblePrimarySource({ sourceUrl: "https://www.nbcsports.com/nfl/news/purdy-leads-49ers", sourceTitle: "Purdy leads 49ers" }, teams, trusted)).toBe(true);
    expect(isEligiblePrimarySource({ sourceUrl: "https://www.nbcsports.com/betting/nfl/news/49ers-vs-commanders-odds-expert-picks", sourceTitle: "49ers vs Commanders Odds, expert picks" }, teams, trusted)).toBe(false);
    expect(isEligiblePrimarySource({ sourceUrl: "https://random-blog.example/x", sourceTitle: "x" }, teams, trusted)).toBe(false);
  });
});

