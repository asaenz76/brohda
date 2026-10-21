import { describe, expect, it } from "vitest";
import { claimAppearsInText, claimedFigures, isTrustedFactSource, originalPublisherDomain, staleNumberCandidates, domainMatches, domainOf, draftHints, isBettingPage, isEligiblePrimarySource, isCreditablePage, isStoryPage, isTrustedSource, teamSiteLabels, reconcileSeasonScope, styleProblems, unsupportedQuotes, validateDraft, verificationReasons } from "@/lib/game-previews/validation";
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

describe("an official team website is recognised by its whole domain label", () => {
  const trusted = ["espn.com"];
  const trustedFor = (url: string, ...teams: string[]) => isTrustedSource(url, teams, trusted);
  it("accepts the real NFL/NBA/NHL patterns: nickname, the+nickname, city+nickname, city initials+nickname, two-word nicknames, numbers", () => {
    expect(trustedFor("https://www.therams.com/news/rams-injury-updates", "Los Angeles Rams", "Las Vegas Raiders")).toBe(true);
    expect(trustedFor("https://www.detroitlions.com/news/x", "Green Bay Packers", "Detroit Lions")).toBe(true);
    expect(trustedFor("https://www.buffalobills.com/news/x", "Buffalo Bills", "Miami Dolphins")).toBe(true);
    expect(trustedFor("https://www.chargers.com/news/x", "Los Angeles Chargers", "Kansas City Chiefs")).toBe(true);
    expect(trustedFor("https://www.nygiants.com/news/x", "New York Giants", "Houston Texans")).toBe(true);
    expect(trustedFor("https://www.49ers.com/news/x", "San Francisco 49ers", "Atlanta Falcons")).toBe(true);
    expect(trustedFor("https://www.mapleleafs.com/news/x", "Toronto Maple Leafs", "Columbus Blue Jackets")).toBe(true);
    expect(trustedFor("https://www.bluejackets.com/news/x", "Toronto Maple Leafs", "Columbus Blue Jackets")).toBe(true);
    expect(trustedFor("https://www.miamiheat.com/news/x", "Minnesota Timberwolves", "Miami Heat")).toBe(true);
  });
  it("rejects look-alikes and unrelated hosts: a substring is not a team site, and a team site of a team not in this Game is not trusted for it", () => {
    for (const url of ["https://www.cheat.com/x", "https://www.therams-blog.com/x", "https://www.ramsfans.com/x", "https://www.lakingsinsider.com/x", "https://www.fieldgulls.com/x", "https://www.prideofdetroit.com/x"]) expect(trustedFor(url, "Los Angeles Rams", "Miami Heat", "Los Angeles Kings", "Seattle Seahawks", "Detroit Lions"), url).toBe(false);
    expect(trustedFor("https://www.packers.com/news/x", "Los Angeles Rams", "Las Vegas Raiders")).toBe(false);
  });
  it("teamSiteLabels lists the labels explicitly", () => {
    expect([...teamSiteLabels("Los Angeles Rams")].sort()).toEqual(expect.arrayContaining(["rams", "therams", "losangelesrams", "larams"]));
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

describe("(tests J, K) betting detection is about the page's purpose, not one editorial word", () => {
  it("J: an ordinary editorial page is NOT betting even when 'predictions', 'picks' or 'preview' appear in it", () => {
    for (const [url, title] of [
      ["https://www.espn.com/nba/story/_/id/49998634/2026-27-nba-season-preview-rankings-predictions-every-team", "2026-27 NBA season preview: rankings, predictions for every team"],
      ["https://www.espn.com/nfl/preview/_/gameId/401892543", "Chiefs vs. Seahawks preview"],
      ["https://www.nfl.com/news/week-7-picks-who-we-pick-to-win-every-division", "Who we pick to win every division"],
      ["https://www.nba.com/news/2026-27-season-preview-hou", "2026-27 Season Preview: Houston Rockets"],
      ["https://www.espn.com/nfl/story/_/id/7/fpi-predictions-playoff-chances", "FPI predictions: playoff chances for all 32 teams"],
    ]) expect(isBettingPage(url, title), url).toBe(false);
  });
  it("K: an actual sportsbook / betting / odds article IS betting", () => {
    for (const [url, title] of [
      ["https://www.nbcsports.com/betting/nfl/news/49ers-vs-commanders-odds-expert-picks-team-and-player-news", "49ers vs. Commanders odds, expert picks"],
      ["https://www.foxsports.com/nfl/best-bets-week-6", "Best bets for Week 6"],
      ["https://www.cbssports.com/nfl/picks/experts/", "Expert picks"],
      ["https://www.espn.com/nfl/story/_/id/2/x", "Chargers vs. Chiefs odds, picks and predictions"],
      ["https://www.example.com/nfl/chiefs-seahawks-prediction-and-spread-pick", "Chiefs vs Seahawks prediction and spread pick"],
      ["https://www.espn.com/nfl/story/_/id/9/x", "Best prop bets for Sunday"],
    ]) expect(isBettingPage(url, title), url).toBe(true);
  });
});

describe("(tests B, C, D) evidence eligibility is not public-credit eligibility", () => {
  const credit = (url: string, title = "A story") => isCreditablePage(url, title);
  it("B: a raw JSON/API endpoint is valid evidence but never a public credit", () => {
    expect(credit("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard")).toBe(false);
    expect(credit("https://example.com/feed.json")).toBe(false);
  });
  it("C: a schedule PDF or any uploaded document is not a public credit", () => {
    expect(credit("https://cdn.nba.com/teams/uploads/sites/1610612744/2026/08/Warriors-2026-27-Schedule_list.pdf")).toBe(false);
    expect(credit("https://www.nfl.com/schedules/2026/by-team/detroit-lions")).toBe(false);
  });
  it("D: a live injury list, stats table, standings or roster page is not the preferred credit", () => {
    for (const url of ["https://www.espn.com/nfl/team/injuries/_/name/gb/green-bay-packers", "https://www.espn.com/nfl/standings", "https://www.espn.com/nba/team/stats/_/name/bos", "https://www.espn.com/nfl/team/roster/_/name/kc", "https://www.espn.com/nfl/team/schedule/_/name/ind/season/2025"]) expect(credit(url), url).toBe(false);
  });
  it("live player profile / player-stats pages are valid evidence but not the public credit (ESPN, NFL.com, NBA.com, CBS, PFR, FOX patterns)", () => {
    for (const url of ["https://www.espn.com/nfl/player/_/id/3916387/lamar-jackson", "https://www.espn.com/nba/player/stats/_/id/1/x", "https://www.nfl.com/players/lamar-jackson/", "https://www.nba.com/player/1629029/luka-doncic", "https://www.cbssports.com/nfl/players/123/lamar-jackson/", "https://www.pro-football-reference.com/players/J/JackLa00.htm", "https://www.foxsports.com/nfl/micah-parsons-player", "https://www.espn.com/nfl/player/gamelog/_/id/1/x"]) expect(credit(url), url).toBe(false);
    // a reported story ABOUT a player stays creditable
    for (const url of ["https://www.espn.com/nfl/story/_/id/50221818/packers-josh-jacobs-practice-wednesday-play-sunday", "https://www.nbcsports.com/fantasy/football/player-news/2026-10-17/optimism-baker-mayfield", "https://www.cbssports.com/fantasy/football/news/vikings-jordan-mason-ready-to-practice/", "https://www.nba.com/news/andre-drummond-joins-knicks-media-day"]) expect(credit(url), url).toBe(true);
  });
  it("readable editorial pages stay creditable, including articles whose slug mentions an injury report or a schedule", () => {
    for (const url of ["https://www.nhl.com/devils/news/preview-2026020142", "https://www.espn.com/nfl/story/_/id/401/chiefs-injury-report-schedule-notes", "https://sports.yahoo.com/articles/celtics-announce-injury-report-ahead-193847873.html", "https://www.nba.com/news/andre-drummond-joins-knicks-media-day", "https://www.espn.com/nfl/preview/_/gameId/401892543"]) expect(credit(url), url).toBe(true);
  });
  it("trusted AND creditable is what makes a source eligible as the public primary; evidence from any non-blocked source stays usable", () => {
    const teams = ["Green Bay Packers", "Detroit Lions"];
    expect(isEligiblePrimarySource({ sourceUrl: "https://www.espn.com/nfl/team/injuries/_/name/gb/green-bay-packers", sourceTitle: "Packers injuries" }, teams, ["espn.com"])).toBe(false);
    expect(isEligiblePrimarySource({ sourceUrl: "https://www.espn.com/nfl/story/_/id/5/packers-lose-parsons", sourceTitle: "Packers lose Parsons" }, teams, ["espn.com"])).toBe(true);
  });
});

describe("betting pages are never the credited primary source", () => {
  it("recognises betting, odds, picks and prediction pages by URL or title — even on a trusted domain", () => {
    for (const url of ["https://www.nbcsports.com/betting/nfl/news/49ers-vs-commanders-odds-expert-picks-team-and-player-news", "https://www.espn.com/nfl/odds", "https://www.foxsports.com/nfl/best-bets-week-6", "https://www.cbssports.com/nfl/picks/experts/", "https://www.nfl.com/news/chargers-vs-chiefs-odds-prediction-picks"]) expect(isBettingPage(url), url).toBe(true);
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

describe("(tests A, C, D, F) the deterministic freshness signal for current-state numbers", () => {
  const lions = { homeTeam: "Detroit Lions", awayTeam: "Green Bay Packers", lastCompleted: [{ team: "Green Bay Packers", completedUtc: "2026-10-19T03:00:00.000Z" }, { team: "Detroit Lions", completedUtc: "2026-10-11T20:00:00.000Z" }] };
  const num = (over = {}) => fact({ id: "n1", kind: "current", numberKind: "CURRENT_STATE", subjectTeam: "Green Bay Packers", claim: "Green Bay averages 60.4 rushing yards per game through five games.", publishedAt: "2026-10-12T10:00:00.000Z", ...over });
  it("A: a current-state number whose evidence predates the team's latest completed Game is a STALE_CANDIDATE (not false: it must be refreshed)", () => {
    const out = staleNumberCandidates([num()], lions);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ factId: "n1" });
    expect(out[0].reason).toMatch(/Game was completed .* after this number's evidence/);
  });
  it("the figure's own as-of date is the evidence date when the page gives one", () => {
    expect(staleNumberCandidates([num({ publishedAt: "2026-10-20T10:00:00.000Z", asOf: "2026-10-12T00:00:00.000Z" })], lions)).toHaveLength(1); // a fresh page quoting an old figure
    expect(staleNumberCandidates([num({ publishedAt: "2026-10-12T10:00:00.000Z", asOf: "2026-10-19T12:00:00.000Z" })], lions)).toEqual([]);
  });
  it("C: a FIXED number (a specific completed game, last season, entering the season) is never stale, however many Games have been played since", () => {
    for (const claim of ["He gained 118 yards against Chicago on Oct. 5.", "Ovechkin entered the season with 929 career goals.", "The Packers won the 2025 series 2-0."]) expect(staleNumberCandidates([num({ numberKind: "FIXED", claim })], lions)).toEqual([]);
    expect(staleNumberCandidates([num({ numberKind: "NONE" }), num({ numberKind: undefined })], lions)).toEqual([]); // unclassified or no figure: no gate
  });
  it("F: a current source published after the latest completed Game is not flagged", () => {
    expect(staleNumberCandidates([num({ publishedAt: "2026-10-19T14:00:00.000Z" })], lions)).toEqual([]);
  });
  it("the cutoff is the team's own latest Game: the Lions' number from Oct. 12 is fresh after their Oct. 11 Game, the Packers' is not after theirs on Oct. 19", () => {
    expect(staleNumberCandidates([num({ subjectTeam: "Detroit Lions", publishedAt: "2026-10-12T10:00:00.000Z" })], lions)).toEqual([]);
    expect(staleNumberCandidates([num({ subjectTeam: "Green Bay Packers" })], lions)).toHaveLength(1);
    expect(staleNumberCandidates([num({ subjectTeam: null })], lions)).toHaveLength(1); // no team named: either team's latest Game counts
  });
  it("a date with no time of day covers that whole day; no evidence date at all is a candidate; an opener has nothing to be stale against", () => {
    expect(staleNumberCandidates([num({ publishedAt: "2026-10-19T00:00:00.000Z" })], lions)).toEqual([]);
    expect(staleNumberCandidates([num({ publishedAt: null, asOf: null })], lions)).toHaveLength(1);
    expect(staleNumberCandidates([num({ publishedAt: null })], { ...lions, lastCompleted: [] })).toEqual([]);
    // Unknown is NOT "none": if the schedule data was unavailable, freshness cannot be shown for any current-state number.
    expect(staleNumberCandidates([num({ publishedAt: "2026-10-20T10:00:00.000Z" }), num({ id: "n3", numberKind: "FIXED" })], { ...lions, lastCompleted: undefined }).map((c) => c.factId)).toEqual(["n1"]);
  });
  it("D: the hints tell the reviewer which cited figures are FIXED ('entering the season') and which are current-state, with what they are current through", () => {
    const fixed = fact({ id: "g1", numberKind: "FIXED", asOfLabel: "entering the season", claim: "Ovechkin entered the season with 929 career goals." });
    const cur = num({ id: "n2", asOfLabel: "through 5 games" });
    const d = { hook: "t", preview: "Ovechkin already has 929.", claims: [{ text: "He has 929.", factIds: ["g1"] }, { text: "Packers average 60.4.", factIds: ["n2"] }] };
    const hints = draftHints(d, [fixed, cur]);
    expect(hints.fixedNumbers).toEqual(["g1: entering the season"]);
    expect(hints.staleNumbers).toEqual(["n2: current through through 5 games"]);
  });
});

describe("(test N) a claim counts as public only if it is stated in the title or caption", () => {
  const text = "Davante Adams ruptured his hamstring in the Rams' 18-16 loss to Arizona and will miss 6 to 10 weeks. He won't play at Las Vegas on Sunday.";
  it("a claim kept only in the research metadata (a kickoff time never mentioned) is not public", () => {
    expect(claimAppearsInText("The Rams play at the Raiders in Week 7 on Oct. 25 at 1:25 p.m. at Allegiant Stadium.", text)).toBe(false);
  });
  it("a claim the caption states (numbers and most distinctive words present) is public", () => {
    expect(claimAppearsInText("Davante Adams ruptured his hamstring in the Rams' 18-16 loss to Arizona.", text)).toBe(true);
    expect(claimAppearsInText("Adams ruptured his hamstring against Arizona and will miss 6 to 10 weeks.", text)).toBe(true);
    expect(claimAppearsInText("Adams has 30 catches for 480 yards.", text)).toBe(false);
  });
});

describe("Yahoo policy: hosting never makes a story trusted; the original publisher decides, only if already trusted", () => {
  const trusted = ["espn.com", "si.com", "nfl.com"];
  const teams = ["Seattle Seahawks", "Kansas City Chiefs"];
  const yahoo = "https://sports.yahoo.com/articles/walker-returns-123.html";
  it("a Yahoo page with no identified original publisher is NOT trusted", () => {
    expect(isTrustedFactSource({ sourceUrl: yahoo }, teams, trusted)).toBe(false);
  });
  it("a Yahoo page whose original publisher (by URL or by a known name) is already trusted IS trusted; an untrusted original stays untrusted", () => {
    expect(isTrustedFactSource({ sourceUrl: yahoo, originalUrl: "https://www.si.com/nfl/seahawks/onsi/x" }, teams, trusted)).toBe(true);
    expect(isTrustedFactSource({ sourceUrl: yahoo, originalPublisher: "Sports Illustrated" }, teams, trusted)).toBe(true);
    expect(isTrustedFactSource({ sourceUrl: yahoo, originalPublisher: "Chiefs Wire", originalUrl: "https://chiefswire.usatoday.com/x" }, teams, trusted)).toBe(false);
    expect(isTrustedFactSource({ sourceUrl: yahoo, originalPublisher: "The Sporting News" }, teams, trusted)).toBe(false);
    expect(isTrustedFactSource({ sourceUrl: yahoo, originalPublisher: "Sports Illustrated" }, teams, ["espn.com"])).toBe(false); // SI is not on THIS trusted list: nothing is added automatically
  });
  it("an unknown publisher name is never guessed into a domain, and an aggregator URL is not an original", () => {
    expect(originalPublisherDomain({ originalPublisher: "Seattle Seahawks On SI" })).toBeNull();
    expect(originalPublisherDomain({ originalUrl: "https://sports.yahoo.com/other" })).toBeNull();
    expect(originalPublisherDomain({ originalPublisher: "ESPN" })).toBe("espn.com");
  });
  it("trusted by original publisher AND readable makes the syndicated page an eligible public primary; the evidence URL is the page actually used", () => {
    const f = { sourceUrl: yahoo, sourceTitle: "Walker returns to Lumen Field", originalPublisher: "Sports Illustrated" };
    expect(isEligiblePrimarySource(f, teams, trusted)).toBe(true);
    expect(isEligiblePrimarySource({ ...f, originalPublisher: "The Sporting News" }, teams, trusted)).toBe(false);
  });
});

