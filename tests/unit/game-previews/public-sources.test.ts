import { describe, expect, it } from "vitest";
import { derivePublicSources, sourceDisplayName } from "@/lib/game-previews/public-sources";

const row = (url: string, provider = "", title = "T", publishedAt: string | null = null) => ({ url, provider, title, publishedAt });

describe("sourceDisplayName", () => {
  it("uses the name Members know for the leagues and major outlets", () => {
    expect(sourceDisplayName("https://www.espn.com/nfl/story/1", "")).toBe("ESPN");
    expect(sourceDisplayName("https://africa.espn.com/x", "whatever")).toBe("ESPN");
    expect(sourceDisplayName("https://www.nhl.com/rangers/news/x", "")).toBe("NHL.com");
    expect(sourceDisplayName("https://www.foxsports.com/stories/x", "")).toBe("FOX Sports");
    expect(sourceDisplayName("https://www.cbssports.com/x", "")).toBe("CBS Sports");
  });
  it("otherwise the provider the research named, otherwise a readable domain (a team site reads as the team)", () => {
    expect(sourceDisplayName("https://www.chargers.com/news/x", "Los Angeles Chargers")).toBe("Los Angeles Chargers");
    expect(sourceDisplayName("https://www.chargers.com/news/x", "")).toBe("Chargers.com");
    expect(sourceDisplayName("https://www.chargers.com/news/x", "chargers.com")).toBe("Chargers.com");
  });
});

describe("derivePublicSources — never a bibliography", () => {
  const a = row("https://www.espn.com/a", "ESPN", "Chiefs pass rush", "2026-10-15T10:00:00.000Z");
  const b = row("https://www.nfl.com/b", "NFL.com", "B");
  const c = row("https://www.foxsports.com/c", "FOX", "C");

  it("a Preview that recorded its public sources shows exactly those, in order, at most two", () => {
    expect(derivePublicSources([a, b, c], { publicSourceUrls: [a.url, b.url, c.url] }).map((s) => s.name)).toEqual(["ESPN", "NFL.com"]);
    expect(derivePublicSources([a, b, c], { publicSourceUrls: [b.url] })).toEqual([{ url: b.url, name: "NFL.com", title: "B", publishedAt: null }]);
  });
  it("an earlier Preview (nothing recorded) shows its first, primary source only", () => {
    expect(derivePublicSources([a, b], {}).map((s) => s.url)).toEqual([a.url]);
    expect(derivePublicSources([a, b], null).map((s) => s.url)).toEqual([a.url]);
  });
  it("carries the title and publication time, drops duplicates, ignores recorded urls that are not stored sources", () => {
    expect(derivePublicSources([a], { publicSourceUrls: [a.url, a.url, "https://nowhere.example/x"] })).toEqual([{ url: a.url, name: "ESPN", title: "Chiefs pass rush", publishedAt: "2026-10-15T10:00:00.000Z" }]);
  });
  it("no stored source means nothing to credit", () => {
    expect(derivePublicSources([], { publicSourceUrls: [a.url] })).toEqual([]);
  });
});

describe("betting pages are never credited", () => {
  const news = row("https://www.nbcsports.com/nfl/news/purdy-leads-49ers", "NBC Sports", "Purdy leads 49ers");
  const betting = row("https://www.nbcsports.com/betting/nfl/news/49ers-vs-commanders-odds-expert-picks", "NBC Sports", "49ers vs Commanders Odds, expert picks");
  const cbs = row("https://www.cbssports.com/nfl/teams/sf/injuries/", "CBS Sports", "49ers injuries");

  it("a Preview whose PRIMARY source is a betting page has nothing eligible to credit and is not shown", () => {
    expect(derivePublicSources([betting, cbs], { primarySourceUrl: betting.url, publicSourceUrls: [betting.url, cbs.url] })).toEqual([]);
    expect(derivePublicSources([betting, cbs], {})).toEqual([]); // an earlier Preview: its first, primary source is the betting page
  });
  it("a betting page is never listed as an 'Also'", () => {
    expect(derivePublicSources([news, betting], { primarySourceUrl: news.url, publicSourceUrls: [news.url, betting.url] }).map((s) => s.name)).toEqual(["NBC Sports"]);
  });
});

describe("derivePublicSources: the credit must link to a page a Member can read", () => {
  it("a data endpoint (a JSON scoreboard or schedule API) is never credited: such a Preview shows no source and is not shown", () => {
    expect(derivePublicSources([row("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", "ESPN", "NFL scoreboard")], {})).toEqual([]);
    const story = row("https://www.espn.com/nfl/story/_/id/1/x", "ESPN", "Story");
    expect(derivePublicSources([story, row("https://example.com/feed.json", "X", "Feed")], { publicSourceUrls: [story.url, "https://example.com/feed.json"] }).map((s) => s.url)).toEqual([story.url]);
  });
});

