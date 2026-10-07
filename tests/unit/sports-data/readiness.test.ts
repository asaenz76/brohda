import { describe, expect, it, vi } from "vitest";
import { evaluateReadiness, formatReadiness, type ReadinessSnapshot } from "@/lib/sports-data/readiness";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import type { BackgroundJobRow } from "@/lib/jobs/health";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-10-06T18:00:00Z");
const NHL = getSportConfig("hockey")!;
const jobNames = ["sync-fixtures-nfl", "ingest-nfl-markets", "publish-posts", "distribute-posts", "grade-predictions", "resolve-challenges", "settle-monetary-positions"];
const goodJobs = (): BackgroundJobRow[] => jobNames.map((job_name) => ({ job_name, status: "success", result: {}, error: null, started_at: "2026-10-06T17:59:00Z", finished_at: "2026-10-06T17:59:30Z", duration_ms: 500 }));

function ready(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    now: NOW, config: NHL, enabled: true, keyConfigured: true, adapterRegistered: true,
    teams: { count: 32, withoutHttpsLogo: 0, duplicateNames: [] },
    leagues: { count: 1, withoutHttpsLogo: 0 },
    communities: { teamsWithoutCommunity: 0, teamsWithDuplicateCommunity: 0, leagueCommunity: true, sportCommunity: true, duplicateSlugs: 0 },
    fixtures: { total: 1500, duplicateExternalIds: 0, upcomingNext14d: 40, completedWithScores: 12, completedLevelInNoTieSport: 0 },
    inventory: { upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 8, duplicatePosts: 0, marketsWithBadShape: 0 },
    jobs: goodJobs(), stalenessMultiplier: 3, notificationsEnabled: true, ...overrides,
  };
}
const failing = (s: ReadinessSnapshot) => evaluateReadiness(s).filter((i) => i.status === "FAIL").map((i) => i.id);

describe("sport readiness — PASS/FAIL per item", () => {
  it("a fully prepared sport passes every item", () => {
    const items = evaluateReadiness(ready());
    expect(items.map((i) => i.id)).toEqual(["enabled", "teams-synced", "fixtures-present", "markets-present", "posts-present", "provider-results", "grading-green", "logos", "communities", "jobs-healthy", "feed", "notifications"]);
    expect(failing(ready())).toEqual([]);
    expect(formatReadiness(NHL, items)).toContain("NHL: PRODUCTION READY");
  });

  it("not enabled / no key / no adapter each fail 'enabled' with the right reason", () => {
    expect(evaluateReadiness(ready({ enabled: false })).find((i) => i.id === "enabled")!.detail).toContain("API_NHL_ENABLED");
    expect(evaluateReadiness(ready({ keyConfigured: false })).find((i) => i.id === "enabled")!.detail).toContain("key");
    expect(evaluateReadiness(ready({ adapterRegistered: false })).find((i) => i.id === "enabled")!.detail).toContain("cannot be launched");
  });

  it("the franchise count and duplicate team names are checked against the registry", () => {
    expect(failing(ready({ teams: { count: 31, withoutHttpsLogo: 0, duplicateNames: [] } }))).toEqual(["teams-synced"]);
    expect(evaluateReadiness(ready({ teams: { count: 32, withoutHttpsLogo: 0, duplicateNames: ["Boston Bruins"] } })).find((i) => i.id === "teams-synced")!.detail).toContain("Boston Bruins");
  });

  it("Games, Markets and Posts must line up: a Game inside the odds window without a Market, or with a Market but no published Post, fails", () => {
    expect(failing(ready({ inventory: { upcomingInOddsWindow: 8, withActiveMarket: 7, withActiveMarketAndPublishedPost: 7, duplicatePosts: 0, marketsWithBadShape: 0 } }))).toEqual(["markets-present"]);
    expect(failing(ready({ inventory: { upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 6, duplicatePosts: 0, marketsWithBadShape: 0 } }))).toEqual(["posts-present"]);
    expect(failing(ready({ inventory: { upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 8, duplicatePosts: 1, marketsWithBadShape: 0 } }))).toEqual(["posts-present"]);
    expect(failing(ready({ inventory: { upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 8, duplicatePosts: 0, marketsWithBadShape: 2 } }))).toEqual(["markets-present"]);
  });

  it("an inconsistent level final in a no-tie sport fails 'grading green'; the result path is unproven until a completed Game carries scores", () => {
    expect(failing(ready({ fixtures: { total: 1, duplicateExternalIds: 0, upcomingNext14d: 3, completedWithScores: 5, completedLevelInNoTieSport: 1 } }))).toEqual(["grading-green"]);
    expect(failing(ready({ fixtures: { total: 1, duplicateExternalIds: 0, upcomingNext14d: 3, completedWithScores: 0, completedLevelInNoTieSport: 0 } }))).toEqual(["provider-results"]);
  });

  it("duplicate Games fail; no upcoming Games fail", () => {
    expect(failing(ready({ fixtures: { total: 9, duplicateExternalIds: 2, upcomingNext14d: 3, completedWithScores: 1, completedLevelInNoTieSport: 0 } }))).toEqual(["fixtures-present"]);
    expect(failing(ready({ fixtures: { total: 9, duplicateExternalIds: 0, upcomingNext14d: 0, completedWithScores: 1, completedLevelInNoTieSport: 0 } }))).toEqual(["fixtures-present"]);
  });

  it("logos and Communities", () => {
    expect(failing(ready({ teams: { count: 32, withoutHttpsLogo: 3, duplicateNames: [] } }))).toEqual(["logos"]);
    expect(failing(ready({ communities: { teamsWithoutCommunity: 2, teamsWithDuplicateCommunity: 0, leagueCommunity: true, sportCommunity: true, duplicateSlugs: 0 } }))).toEqual(["communities"]);
    expect(failing(ready({ communities: { teamsWithoutCommunity: 0, teamsWithDuplicateCommunity: 0, leagueCommunity: false, sportCommunity: true, duplicateSlugs: 0 } }))).toEqual(["communities"]);
  });

  it("jobs: a degraded, failed, stale or never-run job fails 'jobs healthy' and names the job", () => {
    const degraded = goodJobs();
    degraded[4] = { ...degraded[4], status: "degraded", result: { failures: [{ error: "x" }] } };
    const items = evaluateReadiness(ready({ jobs: degraded }));
    expect(items.find((i) => i.id === "jobs-healthy")).toMatchObject({ status: "FAIL" });
    expect(items.find((i) => i.id === "jobs-healthy")!.detail).toContain("grade-predictions (degraded");
    expect(failing(ready({ jobs: [] }))).toEqual(["jobs-healthy"]);
    const stale = goodJobs().map((j) => ({ ...j, finished_at: "2026-10-05T00:00:00Z" }));
    expect(failing(ready({ jobs: stale }))).toEqual(["jobs-healthy"]);
  });

  it("feed and notifications", () => {
    expect(failing(ready({ inventory: { upcomingInOddsWindow: 0, withActiveMarket: 0, withActiveMarketAndPublishedPost: 0, duplicatePosts: 0, marketsWithBadShape: 0 } }))).toEqual(expect.arrayContaining(["feed", "markets-present", "posts-present"]));
    expect(failing(ready({ notificationsEnabled: false }))).toEqual(["notifications"]);
  });

  it("the report says NOT READY and counts the failures", () => {
    const text = formatReadiness(NHL, evaluateReadiness(ready({ enabled: false, notificationsEnabled: false })));
    expect(text).toContain("NHL: NOT READY (2 items failing)");
    expect(text).toMatch(/FAIL\s+NHL enabled/);
  });
});
