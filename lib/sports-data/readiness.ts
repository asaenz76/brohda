// "Is this sport actually ready for members?" — one repeatable answer, PASS/FAIL per item, for any sport in the shared registry (used for the NHL
// today and the NBA's opening night, and for the NFL as the baseline). Two halves, deliberately separate:
//
//   evaluateReadiness(snapshot)  — PURE. Takes plain facts, returns the checklist. Unit-tested.
//   loadReadinessSnapshot(...)   — reads those facts from the database (read-only; no provider calls, no writes).
//
// Nothing here is sport-specific: the sport is a registry row, and every expectation (league ids, franchise count, odds window) comes from it.
// A sport is not "supported" because fixtures exist — every item below must PASS.
import { JOB_REGISTRY } from "@/lib/jobs/registry";
import { computeJobHealth, type BackgroundJobRow } from "@/lib/jobs/health";
import type { SportConfig } from "./sport-registry";

export type ReadinessStatus = "PASS" | "FAIL";

export interface ReadinessItem {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
}

export interface ReadinessSnapshot {
  now: Date;
  config: SportConfig;
  /** The provider's environment flag is on and a key is available. */
  enabled: boolean;
  keyConfigured: boolean;
  /** A provider adapter is registered for the sport (MLB: false by design). */
  adapterRegistered: boolean;
  teams: { count: number; withoutHttpsLogo: number; duplicateNames: string[] };
  leagues: { count: number; withoutHttpsLogo: number };
  communities: { teamsWithoutCommunity: number; teamsWithDuplicateCommunity: number; leagueCommunity: boolean; sportCommunity: boolean; duplicateSlugs: number };
  fixtures: { total: number; duplicateExternalIds: number; upcomingNext14d: number; completedWithScores: number; completedLevelInNoTieSport: number };
  /** Upcoming Games inside the odds window, how many have an ACTIVE Market, and how many of those have a published Post. */
  inventory: { upcomingInOddsWindow: number; withActiveMarket: number; withActiveMarketAndPublishedPost: number; duplicatePosts: number; marketsWithBadShape: number };
  jobs: BackgroundJobRow[];
  stalenessMultiplier: number;
  notificationsEnabled: boolean;
}

const item = (id: string, label: string, ok: boolean, passDetail: string, failDetail: string): ReadinessItem => ({ id, label, status: ok ? "PASS" : "FAIL", detail: ok ? passDetail : failDetail });

const JOBS_THAT_MUST_BE_HEALTHY = ["sync-fixtures-nfl", "ingest-nfl-markets", "publish-posts", "distribute-posts", "grade-predictions", "resolve-challenges", "settle-monetary-positions"] as const;

export function evaluateReadiness(s: ReadinessSnapshot): ReadinessItem[] {
  const c = s.config;
  const items: ReadinessItem[] = [];

  items.push(item("enabled", `${c.label} enabled`, s.enabled && s.keyConfigured && s.adapterRegistered, `${c.envPrefix}_ENABLED is on, a provider key is configured and an adapter is registered.`,
    !s.adapterRegistered ? "No provider adapter is registered for this sport — it cannot be launched." : !s.enabled ? `${c.envPrefix}_ENABLED is not "true".` : "No provider API key is available (set the sport's key or API_SPORTS_KEY)."));

  items.push(item("teams-synced", "Teams synced", s.teams.count === c.expectedTeamCount && s.teams.duplicateNames.length === 0, `${s.teams.count} teams, no duplicate names.`,
    s.teams.duplicateNames.length > 0 ? `Duplicate team names: ${s.teams.duplicateNames.join(", ")}.` : `${s.teams.count} teams synced, expected ${c.expectedTeamCount}.`));

  items.push(item("fixtures-present", "Upcoming Games present", s.fixtures.upcomingNext14d > 0 && s.fixtures.duplicateExternalIds === 0, `${s.fixtures.upcomingNext14d} upcoming Games in the next 14 days; no duplicate provider ids.`,
    s.fixtures.duplicateExternalIds > 0 ? `${s.fixtures.duplicateExternalIds} duplicate provider game ids.` : `No upcoming Games in the next 14 days (${s.fixtures.total} Games stored in total).`));

  const withoutMarket = s.inventory.upcomingInOddsWindow - s.inventory.withActiveMarket;
  items.push(item("markets-present", "Markets present for upcoming Games", s.inventory.upcomingInOddsWindow > 0 && withoutMarket === 0 && s.inventory.marketsWithBadShape === 0,
    `${s.inventory.withActiveMarket}/${s.inventory.upcomingInOddsWindow} upcoming Games inside the odds window have an ACTIVE Market; every Market is gradeable.`,
    s.inventory.upcomingInOddsWindow === 0 ? "No upcoming Games inside the odds window." : s.inventory.marketsWithBadShape > 0 ? `${s.inventory.marketsWithBadShape} Markets would be ungradeable.` : `${withoutMarket} upcoming Game(s) inside the odds window have no ACTIVE Market (the provider may not have odds yet).`));

  const unpublished = s.inventory.withActiveMarket - s.inventory.withActiveMarketAndPublishedPost;
  items.push(item("posts-present", "Posts published (one per Game)", unpublished === 0 && s.inventory.withActiveMarket > 0 && s.inventory.duplicatePosts === 0, `${s.inventory.withActiveMarketAndPublishedPost}/${s.inventory.withActiveMarket} Games with a Market have a published Post; no Game has two Posts.`,
    s.inventory.duplicatePosts > 0 ? `${s.inventory.duplicatePosts} Games have more than one Post.` : s.inventory.withActiveMarket === 0 ? "No Games with a Market to publish." : `${unpublished} Game(s) with a Market have no published Post.`));

  items.push(item("provider-results", "Provider result path proven (completed Games carry scores)", s.fixtures.completedWithScores > 0, `${s.fixtures.completedWithScores} COMPLETED Games with both scores stored.`,
    "No COMPLETED Game with scores yet — the result path has not been exercised on real provider data."));

  items.push(item("grading-green", "Grading green", s.fixtures.completedLevelInNoTieSport === 0, "No COMPLETED Game with a level score in a sport that cannot end level.",
    `${s.fixtures.completedLevelInNoTieSport} COMPLETED Game(s) with an inconsistent level final — they are NOT graded (see the grade-predictions job failures).`));

  items.push(item("logos", "Logos valid", s.teams.count > 0 && s.teams.withoutHttpsLogo === 0 && s.leagues.withoutHttpsLogo === 0, "Every team and league has a usable logo URL (provider https, or self-hosted).",
    s.teams.count === 0 ? "No teams to check." : `${s.teams.withoutHttpsLogo} team(s) and ${s.leagues.withoutHttpsLogo} league(s) lack a usable (https or self-hosted) logo URL.`));

  const communitiesOk = s.communities.teamsWithoutCommunity === 0 && s.communities.teamsWithDuplicateCommunity === 0 && s.communities.leagueCommunity && s.communities.sportCommunity && s.communities.duplicateSlugs === 0 && s.teams.count > 0;
  items.push(item("communities", "Communities valid", communitiesOk, "Every team has exactly one Community, plus the league and the sport; no duplicate slugs.",
    `Communities incomplete: ${[s.communities.teamsWithoutCommunity && `${s.communities.teamsWithoutCommunity} teams without one`, s.communities.teamsWithDuplicateCommunity && `${s.communities.teamsWithDuplicateCommunity} teams with two`, !s.communities.leagueCommunity && "no league Community", !s.communities.sportCommunity && "no sport Community", s.communities.duplicateSlugs && `${s.communities.duplicateSlugs} duplicate slugs`].filter(Boolean).join("; ") || "no teams yet"}.`));

  const staleness = s.stalenessMultiplier;
  const unhealthy = JOBS_THAT_MUST_BE_HEALTHY.map((id) => JOB_REGISTRY.find((j) => j.id === id)!)
    .map((job) => computeJobHealth(job, s.jobs, s.now, staleness))
    .filter((h) => h.status !== "healthy" && h.status !== "no_op_healthy");
  items.push(item("jobs-healthy", "Jobs healthy", unhealthy.length === 0, "Fixture sync, odds ingestion, publication, distribution, grading, Call BS resolution and settlement all ran recently without failures.",
    `Not healthy: ${unhealthy.map((h) => `${h.job.id} (${h.status}${h.lastError ? `: ${h.lastError}` : ""})`).join(", ")}.`));

  items.push(item("feed", "Feed rendering (published Posts with a Market)", s.inventory.withActiveMarketAndPublishedPost > 0, `${s.inventory.withActiveMarketAndPublishedPost} Posts with an ACTIVE Market are eligible for the feed.`,
    "No published Post with an ACTIVE Market — the sport's feed is empty."));

  items.push(item("notifications", "Notifications enabled", s.notificationsEnabled, "Prediction result notifications are enabled.", "prediction_notifications_enabled is off — members would not be told their Picks were graded."));

  return items;
}

export function formatReadiness(config: SportConfig, items: ReadinessItem[]): string {
  const width = Math.max(...items.map((i) => i.label.length));
  const lines = items.map((i) => `${i.status === "PASS" ? "PASS" : "FAIL"}  ${i.label.padEnd(width)}  ${i.detail}`);
  const failed = items.filter((i) => i.status === "FAIL").length;
  return [`${config.label} readiness`, ...lines, "", failed === 0 ? `${config.label}: PRODUCTION READY` : `${config.label}: NOT READY (${failed} item${failed === 1 ? "" : "s"} failing)`].join("\n");
}
