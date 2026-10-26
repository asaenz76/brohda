/** Evidence normalisation (policy, quarantine, dedupe, cap, contradictions) and the deterministic structured facts. */
import { describe, expect, it } from "vitest";
import { normalizeEvidence, resolveConflicts } from "@/lib/game-stories/evidence";
import { classifySource, canonicalUrl } from "@/lib/game-stories/source-policy";
import { buildStructuredEvidence, type HistoryFixture } from "@/lib/game-stories/structured-evidence";
import { config, ev, game, hoursAgo, id, NOW, raw } from "../../support/game-stories";

const g = game();
const cfg = config();

describe("source policy", () => {
  it("ranks sources by the hierarchy and excludes sportsbooks, social media and wikis", () => {
    expect(classifySource("https://www.nba.com/news/x", g, cfg)).toMatchObject({ kind: "OFFICIAL_LEAGUE", authority: 90 });
    expect(classifySource("https://www.celtics.com/news", g, cfg)).toMatchObject({ kind: "OFFICIAL_TEAM", authority: 85 });
    expect(classifySource("https://www.espn.com/a", g, cfg)).toMatchObject({ kind: "MAJOR_JOURNALISM" });
    expect(classifySource("https://www.bostonglobe.com/a", g, cfg).kind).toBe("OTHER_REPORTING");
    expect(classifySource("https://www.bostonglobe.com/a", g, config({ preferredDomains: ["bostonglobe.com"] })).kind).toBe("LOCAL_JOURNALISM");
    for (const u of ["https://www.draftkings.com/x", "https://x.com/user/status/1", "https://www.reddit.com/r/nba", "https://en.wikipedia.org/wiki/x"]) expect(classifySource(u, g, cfg).blocked).toBe(true);
  });
  it("configuration can add blocked domains but a built-in blocked domain can never be promoted", () => {
    expect(classifySource("https://www.espn.com/a", g, config({ blockedDomains: ["espn.com"] })).blocked).toBe(true);
    expect(classifySource("https://www.draftkings.com/x", g, config({ preferredDomains: ["draftkings.com"] })).blocked).toBe(true);
  });
  it("tracking parameters do not make a URL a different page", () => {
    expect(canonicalUrl("https://www.espn.com/a/?utm_source=x&fbclid=1#frag")).toBe(canonicalUrl("https://espn.com/a"));
  });
});

describe("normalizeEvidence", () => {
  const norm = (items: ReturnType<typeof raw>[], over = {}) => normalizeEvidence(items, g, { ...cfg, ...over }, NOW, id);
  it("deduplicates the same page and fact, and drops items over the source cap (keeping the strongest)", () => {
    const a = raw({ url: "https://www.espn.com/a?utm_medium=z", factText: "Fact one." });
    const dup = raw({ url: "https://espn.com/a", factText: "Fact one." });
    expect(norm([a, dup]).stats.duplicates).toBe(1);
    const many = [raw({ url: "https://www.nba.com/1", factText: "a" }), raw({ url: "https://www.espn.com/2", factText: "b" }), raw({ url: "https://blog.example/3", factText: "c" })];
    const { items, stats } = norm(many, { maxSources: 2 });
    expect(stats.overLimit).toBe(1);
    expect(items.find((i) => i.statusReason === "over_source_limit")!.kind).toBe("OTHER_REPORTING");
  });
  it("the cap counts distinct PAGES, keeps every fact of a kept page (up to a per-page ceiling) and prefers a dated strong page to an undated one", () => {
    const manyFromOnePage = Array.from({ length: 9 }, (_, i) => raw({ url: "https://www.espn.com/one", factText: `Fact number ${i}.` }));
    const { items, stats } = norm(manyFromOnePage, { maxSources: 2 });
    expect(items.filter((i) => i.status === "USABLE")).toHaveLength(6); // one page, 6 facts at most
    expect(stats.overLimit).toBe(3);
    expect(items.find((i) => i.status === "DROPPED")!.statusReason).toBe("over_fact_limit");
    const undatedOfficial = raw({ url: "https://www.nba.com/undated", publishedAt: null, factText: "An undated official fact." });
    const datedMajor = raw({ url: "https://www.espn.com/dated", publishedAt: hoursAgo(3), factText: "A dated major fact." });
    const kept = norm([undatedOfficial, datedMajor], { maxSources: 1 }).items;
    expect(kept.find((i) => i.status === "USABLE")!.factText).toBe("A dated major fact.");
    expect(kept.find((i) => i.status === "DROPPED")!.statusReason).toBe("over_source_limit");
  });
  it("sanitises hidden characters and markup, and ignores an item with no text", () => {
    const { items } = norm([raw({ factText: "Boston​ won <script>alert(1)</script> big." }), raw({ factText: "  " })]);
    expect(items).toHaveLength(1);
    expect(items[0].factText).toBe("Boston won alert(1) big.");
  });
  it("treats a future publication date as unknown rather than fresh", () => {
    expect(norm([raw({ publishedAt: new Date(NOW.getTime() + 10 * 86_400_000).toISOString() })]).items[0].publishedAt).toBeNull();
  });
});

describe("resolveConflicts", () => {
  const k = { factKey: "availability:x" };
  it("the newer source wins when it is at least nearly as authoritative", () => {
    const old = ev({ ...k, factValue: "OUT", publishedAt: hoursAgo(40), authority: 75 });
    const fresh = ev({ ...k, factValue: "PROBABLE", publishedAt: hoursAgo(3), authority: 90 });
    const r = resolveConflicts([old, fresh]);
    expect(old.status).toBe("SUPERSEDED");
    expect(fresh.status).toBe("USABLE");
    expect(r.superseded).toBe(1);
  });
  it("a newer but much weaker source does NOT override a stronger one: both become CONFLICTED", () => {
    const strong = ev({ ...k, factValue: "OUT", publishedAt: hoursAgo(40), authority: 90 });
    const weak = ev({ ...k, factValue: "PROBABLE", publishedAt: hoursAgo(3), authority: 40 });
    resolveConflicts([strong, weak]);
    expect([strong.status, weak.status]).toEqual(["CONFLICTED", "CONFLICTED"]);
  });
  it("equal timestamps cannot be ordered: conflicted", () => {
    const a = ev({ ...k, factValue: "OUT", publishedAt: hoursAgo(5) });
    const b = ev({ ...k, factValue: "PROBABLE", publishedAt: hoursAgo(5) });
    resolveConflicts([a, b]);
    expect(a.status).toBe("CONFLICTED");
  });
  it("sources that agree are untouched", () => {
    const a = ev({ ...k, factValue: "OUT" });
    const b = ev({ ...k, factValue: "OUT", url: "https://www.apnews.com/b" });
    resolveConflicts([a, b]);
    expect([a.status, b.status]).toEqual(["USABLE", "USABLE"]);
  });
});

describe("buildStructuredEvidence (deterministic Game facts)", () => {
  const fx = (n: number, daysAgo: number, home: string, away: string, hs: number | null, as: number | null, status = "COMPLETED"): HistoryFixture => ({
    id: `fx-${n}`, homeTeam: home, awayTeam: away, homeExternalId: null, awayExternalId: null, startUtc: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), status, homeScore: hs, awayScore: as,
  });
  const C = "Boston Celtics", K = "New York Knicks";
  const rows: HistoryFixture[] = [
    fx(1, 10, C, K, 110, 100), fx(2, 40, K, C, 98, 105), fx(3, 90, C, K, 120, 101), fx(4, 4, C, "Miami Heat", 100, 90), fx(5, 8, "Orlando Magic", C, 95, 101), fx(6, 3, K, "Chicago Bulls", 90, 99),
    fx(7, 6, "Toronto Raptors", K, 100, 92), fx(8, 12, K, "Detroit Pistons", 101, 99),
  ];
  const items = buildStructuredEvidence(g, rows, NOW, id);
  const byKey = (k: string) => items.find((i) => i.factKey === k);

  it("computes head-to-head record and streak from results, never from memory", () => {
    expect(byKey("h2h:record")!.factText).toBe("In their last 3 meetings in Brohda's results data, Boston Celtics won 3 and New York Knicks won 0.");
    expect(byKey("h2h:streak")!.factText).toContain("won the last 3 meetings");
    expect(byKey("h2h:last")!.factText).toContain("110-100");
  });
  it("computes form and streaks per team and marks everything STRUCTURED_DATA at the top authority", () => {
    expect(byKey("form:home")!.factText).toContain("won 5 of their last 5");
    expect(byKey("streak:home")!.factText).toContain("has won 5 straight");
    expect(items.every((i) => i.kind === "STRUCTURED_DATA" && i.authority === 95 && i.evidenceType === "STRUCTURED")).toBe(true);
  });
  it("omits a team's form entirely when its schedule data is incomplete (a past Game that never finished)", () => {
    const broken = [...rows, fx(9, 2, K, "Phoenix Suns", null, null, "NOT_STARTED")];
    const out = buildStructuredEvidence(g, broken, NOW, id);
    expect(out.find((i) => i.factKey === "form:away")).toBeUndefined();
    expect(out.find((i) => i.factKey === "form:home")).toBeDefined();
  });
  it("omits form when the latest result is too old to be 'form'", () => {
    const old = rows.map((r) => ({ ...r, startUtc: new Date(Date.parse(r.startUtc) - 60 * 86_400_000).toISOString() }));
    expect(buildStructuredEvidence(g, old, NOW, id).find((i) => i.factKey?.startsWith("form"))).toBeUndefined();
  });
  it("never uses the Game itself or anything that starts after it", () => {
    const self: HistoryFixture = { ...fx(99, 0, C, K, 1, 0), id: g.fixtureId, startUtc: g.kickoffUtc };
    expect(buildStructuredEvidence(g, [self], NOW, id)).toEqual([]);
  });
});
