import { describe, expect, it, vi } from "vitest";
import { evaluateReadiness, formatReadiness, overallVerdict, type ReadinessSnapshot } from "@/lib/sports-data/readiness";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import type { BackgroundJobRow } from "@/lib/jobs/health";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-10-06T18:00:00Z");
const NHL = getSportConfig("hockey")!;
const jobNames = ["sync-fixtures-nfl", "ingest-nfl-markets", "publish-posts", "distribute-posts", "grade-predictions", "resolve-challenges", "settle-monetary-positions"];
const goodJobs = (): BackgroundJobRow[] => jobNames.map((job_name) => ({ job_name, status: "success", result: {}, error: null, started_at: "2026-10-06T17:59:00Z", finished_at: "2026-10-06T17:59:30Z", duration_ms: 500 }));

const NONE = { providerHasNoOdds: 0, providerInsufficientBookmakers: 0, providerErrored: 0, notExamined: 0 };
const inv = (o: Partial<ReadinessSnapshot["inventory"]> = {}): ReadinessSnapshot["inventory"] => ({ upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 8, duplicatePosts: 0, marketsWithBadShape: 0, withoutMarket: NONE, ...o });

function ready(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    now: NOW, config: NHL, enabled: true, keyConfigured: true, adapterRegistered: true,
    teams: { count: 32, withoutHttpsLogo: 0, duplicateNames: [] },
    leagues: { count: 1, withoutHttpsLogo: 0 },
    communities: { teamsWithoutCommunity: 0, teamsWithDuplicateCommunity: 0, leagueCommunity: true, sportCommunity: true, duplicateSlugs: 0 },
    fixtures: { total: 1500, duplicateExternalIds: 0, upcomingNext14d: 40, completedWithScores: 12, completedLevelInNoTieSport: 0 },
    inventory: inv(),
    jobs: goodJobs(), stalenessMultiplier: 3, notificationsEnabled: true, ...overrides,
  };
}
const status = (s: ReadinessSnapshot, id: string) => evaluateReadiness(s).find((i) => i.id === id)!.status;
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
    expect(status(ready({ enabled: false }), "enabled")).toBe("DISABLED"); // switched off by configuration is not a failure
    expect(status(ready({ keyConfigured: false }), "enabled")).toBe("FAIL"); // an enabled sport with no key IS broken
    expect(evaluateReadiness(ready({ adapterRegistered: false })).find((i) => i.id === "enabled")!.detail).toContain("cannot be launched");
  });

  it("the franchise count and duplicate team names are checked against the registry", () => {
    expect(failing(ready({ teams: { count: 31, withoutHttpsLogo: 0, duplicateNames: [] } }))).toEqual(["teams-synced"]);
    expect(evaluateReadiness(ready({ teams: { count: 32, withoutHttpsLogo: 0, duplicateNames: ["Boston Bruins"] } })).find((i) => i.id === "teams-synced")!.detail).toContain("Boston Bruins");
  });

  it("Games, Markets and Posts must line up: a Game inside the odds window without a Market, or with a Market but no published Post, fails", () => {
    expect(failing(ready({ inventory: inv({ upcomingInOddsWindow: 8, withActiveMarket: 7, withActiveMarketAndPublishedPost: 7, duplicatePosts: 0, marketsWithBadShape: 0, withoutMarket: { ...NONE, notExamined: 1 } }) }))).toEqual(["markets-present"]);
    expect(failing(ready({ inventory: inv({ upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 6, duplicatePosts: 0, marketsWithBadShape: 0, withoutMarket: { ...NONE, notExamined: 0 } }) }))).toEqual(["posts-present"]);
    expect(failing(ready({ inventory: inv({ upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 8, duplicatePosts: 1, marketsWithBadShape: 0, withoutMarket: { ...NONE, notExamined: 0 } }) }))).toEqual(["posts-present"]);
    expect(failing(ready({ inventory: inv({ upcomingInOddsWindow: 8, withActiveMarket: 8, withActiveMarketAndPublishedPost: 8, duplicatePosts: 0, marketsWithBadShape: 2, withoutMarket: { ...NONE, notExamined: 0 } }) }))).toEqual(["markets-present"]);
  });

  it("an inconsistent level final in a no-tie sport fails 'grading green'; the result path is unproven until a completed Game carries scores", () => {
    expect(failing(ready({ fixtures: { total: 1, duplicateExternalIds: 0, upcomingNext14d: 3, completedWithScores: 5, completedLevelInNoTieSport: 1 } }))).toEqual(["grading-green"]);
    expect(failing(ready({ fixtures: { total: 1, duplicateExternalIds: 0, upcomingNext14d: 3, completedWithScores: 0, completedLevelInNoTieSport: 0 } }))).toEqual([]);
    expect(status(ready({ fixtures: { total: 1, duplicateExternalIds: 0, upcomingNext14d: 3, completedWithScores: 0, completedLevelInNoTieSport: 0 } }), "provider-results")).toBe("PROOF_PENDING");
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
    expect(failing(ready({ inventory: inv({ upcomingInOddsWindow: 8, withActiveMarket: 0, withActiveMarketAndPublishedPost: 0, withoutMarket: { ...NONE, notExamined: 8 } }) }))).toEqual(expect.arrayContaining(["feed", "markets-present", "posts-present"]));
    expect(failing(ready({ notificationsEnabled: false }))).toEqual(["notifications"]);
  });

  it("the report says BROKEN and counts the failures; a disabled sport says DISABLED, not BROKEN", () => {
    const broken = formatReadiness(NHL, evaluateReadiness(ready({ notificationsEnabled: false, teams: { count: 31, withoutHttpsLogo: 0, duplicateNames: [] } })));
    expect(broken).toContain("NHL: NOT READY — BROKEN (2 items failing)");
    expect(broken).toMatch(/FAIL\s+Teams synced/);
    const disabled = evaluateReadiness(ready({ enabled: false, notificationsEnabled: false }));
    expect(overallVerdict(disabled)).toBe("DISABLED");
    expect(formatReadiness(NHL, disabled)).toContain("NHL: DISABLED");
  });
});

describe("provider has no odds ≠ platform failure — the five statuses", () => {
  const unpriced = (o: Partial<typeof NONE> = {}, extra: Partial<ReadinessSnapshot["inventory"]> = {}) =>
    ready({ inventory: inv({ withActiveMarket: 0, withActiveMarketAndPublishedPost: 0, withoutMarket: { ...NONE, providerHasNoOdds: 8, ...o }, ...extra }) });

  it("every in-window Game unpriced because the provider published nothing: PROVIDER_INVENTORY_UNAVAILABLE across Markets/Posts/Feed, verdict is not BROKEN, exit-code-worthy failures = 0", () => {
    const snap = unpriced();
    const items = evaluateReadiness(snap);
    expect(["markets-present", "posts-present", "feed"].map((id) => items.find((i) => i.id === id)!.status)).toEqual(["PROVIDER_INVENTORY_UNAVAILABLE", "PROVIDER_INVENTORY_UNAVAILABLE", "PROVIDER_INVENTORY_UNAVAILABLE"]);
    expect(items.filter((i) => i.status === "FAIL")).toEqual([]);
    expect(overallVerdict(items)).toBe("PROVIDER_INVENTORY_UNAVAILABLE");
    expect(formatReadiness(NHL, items)).toContain("PROVIDER INVENTORY UNAVAILABLE");
    expect(items.find((i) => i.id === "markets-present")!.detail).toContain("The platform asked and is healthy");
  });

  it("too few bookmakers is also the provider's inventory", () => {
    expect(status(unpriced({ providerHasNoOdds: 3, providerInsufficientBookmakers: 5 }), "markets-present")).toBe("PROVIDER_INVENTORY_UNAVAILABLE");
  });

  it("an odds request that ERRORED is a platform-side failure, never 'no odds'", () => {
    expect(status(unpriced({ providerHasNoOdds: 7, providerErrored: 1 }), "markets-present")).toBe("FAIL");
    expect(overallVerdict(evaluateReadiness(unpriced({ providerHasNoOdds: 7, providerErrored: 1 })))).toBe("BROKEN");
  });

  it("a Game the ingestion run never examined and that has no Market is unexplained, so it FAILS", () => {
    expect(status(unpriced({ providerHasNoOdds: 7, notExamined: 1 }), "markets-present")).toBe("FAIL");
  });

  it("some Games Marketed, the rest simply not priced by the provider yet: PASS (not a defect)", () => {
    const snap = ready({ inventory: inv({ withActiveMarket: 5, withActiveMarketAndPublishedPost: 5, withoutMarket: { ...NONE, providerHasNoOdds: 3 } }) });
    expect(status(snap, "markets-present")).toBe("PASS");
    expect(overallVerdict(evaluateReadiness(snap))).toBe("HEALTHY");
  });

  it("malformed Markets are a failure regardless of provider inventory", () => {
    expect(status(ready({ inventory: inv({ marketsWithBadShape: 1 }) }), "markets-present")).toBe("FAIL");
  });

  it("no Game inside the odds window at all: PROOF_PENDING (nothing to prove against), not a failure", () => {
    const snap = ready({ inventory: inv({ upcomingInOddsWindow: 0, withActiveMarket: 0, withActiveMarketAndPublishedPost: 0 }) });
    expect(status(snap, "markets-present")).toBe("PROOF_PENDING");
    expect(overallVerdict(evaluateReadiness(snap))).toBe("PROOF_PENDING");
  });

  it("no completed Game yet: PROOF_PENDING; a sport with everything proven: HEALTHY / PRODUCTION READY", () => {
    expect(overallVerdict(evaluateReadiness(ready({ fixtures: { total: 9, duplicateExternalIds: 0, upcomingNext14d: 4, completedWithScores: 0, completedLevelInNoTieSport: 0 } })))).toBe("PROOF_PENDING");
    expect(overallVerdict(evaluateReadiness(ready()))).toBe("HEALTHY");
  });

  it("verdict precedence: DISABLED > BROKEN > PROVIDER_INVENTORY_UNAVAILABLE > PROOF_PENDING", () => {
    const both = ready({ inventory: unpriced().inventory, fixtures: { total: 9, duplicateExternalIds: 0, upcomingNext14d: 4, completedWithScores: 0, completedLevelInNoTieSport: 0 } });
    expect(overallVerdict(evaluateReadiness(both))).toBe("PROVIDER_INVENTORY_UNAVAILABLE");
    expect(overallVerdict(evaluateReadiness({ ...both, notificationsEnabled: false }))).toBe("BROKEN");
    expect(overallVerdict(evaluateReadiness({ ...both, notificationsEnabled: false, enabled: false }))).toBe("DISABLED");
  });

  it("per-sport isolation: an ingestion failure that names ANOTHER sport does not make this sport's jobs unhealthy; one that names it (or names none) does", () => {
    const jobsWith = (failures: unknown[]) => goodJobs().map((j) => (j.job_name === "ingest-nfl-markets" ? { ...j, status: "degraded", result: { failures } } : j));
    expect(status(ready({ jobs: jobsWith([{ fixtureId: "x", error: "boom", sport: "basketball" }]) }), "jobs-healthy")).toBe("PASS");
    expect(status(ready({ jobs: jobsWith([{ fixtureId: "x", error: "boom", sport: "hockey" }]) }), "jobs-healthy")).toBe("FAIL");
    expect(status(ready({ jobs: jobsWith([{ fixtureId: "x", error: "boom" }]) }), "jobs-healthy")).toBe("FAIL");
    expect(status(ready({ jobs: jobsWith([{ fixtureId: "x", error: "a", sport: "basketball" }, { fixtureId: "y", error: "b", sport: "hockey" }]) }), "jobs-healthy")).toBe("FAIL");
  });
});
