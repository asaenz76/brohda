// "Is this sport actually ready for members?" — one repeatable answer, PASS/FAIL per item, for any sport in the shared registry (used for the NHL
// today and the NBA's opening night, and for the NFL as the baseline). Two halves, deliberately separate:
//
//   evaluateReadiness(snapshot)  — PURE. Takes plain facts, returns the checklist. Unit-tested.
//   loadReadinessSnapshot(...)   — reads those facts from the database (read-only; no provider calls, no writes).
//
// Nothing here is sport-specific: the sport is a registry row, and every expectation (league ids, franchise count, odds window) comes from it.
// A sport is not "supported" because fixtures exist — but not every non-PASS is a defect. Each item reports ONE of five statuses so the answer to
// "what is wrong?" is never confused with "what is simply not there yet?":
//
//   FAIL                            the platform is broken (a job is failing, data is inconsistent, a provider call errors, nothing explains a gap)
//   DISABLED                        the sport is switched off by configuration — not a failure, nothing else is judged
//   PROVIDER_INVENTORY_UNAVAILABLE  the platform asked and the provider has not published that inventory (e.g. no bookmaker odds yet) — NOT a platform failure
//   PROOF_PENDING                   nothing is wrong, but the real-world proof cannot exist yet (no completed Game, no Game in the odds window)
//   PASS                            proven healthy
//
// The overall verdict (overallVerdict) is derived from those, in that order of precedence.
import { JOB_REGISTRY } from "@/lib/jobs/registry";
import { computeJobHealth, type BackgroundJobRow } from "@/lib/jobs/health";
import type { SportConfig } from "./sport-registry";

export type ReadinessStatus = "PASS" | "FAIL" | "DISABLED" | "PROVIDER_INVENTORY_UNAVAILABLE" | "PROOF_PENDING";
export type ReadinessVerdict = "DISABLED" | "BROKEN" | "PROVIDER_INVENTORY_UNAVAILABLE" | "PROOF_PENDING" | "HEALTHY";

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
  inventory: {
    upcomingInOddsWindow: number;
    withActiveMarket: number;
    withActiveMarketAndPublishedPost: number;
    duplicatePosts: number;
    marketsWithBadShape: number;
    /** Why the in-window Games WITHOUT an ACTIVE Market have none, from the latest ingestion run (every such Game is in exactly one bucket). */
    withoutMarket: { providerHasNoOdds: number; providerInsufficientBookmakers: number; providerErrored: number; notExamined: number };
  };
  jobs: BackgroundJobRow[];
  stalenessMultiplier: number;
  notificationsEnabled: boolean;
}

const item = (id: string, label: string, ok: boolean, passDetail: string, failDetail: string, otherwise: ReadinessStatus = "FAIL"): ReadinessItem => ({ id, label, status: ok ? "PASS" : otherwise, detail: ok ? passDetail : failDetail });

const JOBS_THAT_MUST_BE_HEALTHY = ["sync-fixtures-nfl", "ingest-nfl-markets", "publish-posts", "distribute-posts", "grade-predictions", "resolve-challenges", "settle-monetary-positions"] as const;

/** True when the job's latest run failed ONLY for items that name a different sport (failures carry `sport`; one without it is treated as ours). */
function failuresBelongToOtherSports(jobs: readonly BackgroundJobRow[], jobId: string, sport: string): boolean {
  const latest = jobs.find((j) => j.job_name === jobId);
  const result = latest?.result;
  if (typeof result !== "object" || result === null) return false;
  const failures = (result as { failures?: unknown }).failures;
  if (!Array.isArray(failures) || failures.length === 0) return false;
  return failures.every((f) => typeof f === "object" && f !== null && typeof (f as { sport?: unknown }).sport === "string" && (f as { sport: string }).sport !== sport);
}

export function evaluateReadiness(s: ReadinessSnapshot): ReadinessItem[] {
  const c = s.config;
  const items: ReadinessItem[] = [];

  const enabledOk = s.enabled && s.keyConfigured && s.adapterRegistered;
  items.push(item("enabled", `${c.label} enabled`, enabledOk, `${c.envPrefix}_ENABLED is on, a provider key is configured and an adapter is registered.`,
    !s.adapterRegistered ? "No provider adapter is registered for this sport — it cannot be launched." : !s.enabled ? `${c.envPrefix}_ENABLED is not "true" — the sport is switched off by configuration.` : "No provider API key is available (set the sport's key or API_SPORTS_KEY).",
    !s.adapterRegistered || !s.enabled ? "DISABLED" : "FAIL"));

  items.push(item("teams-synced", "Teams synced", s.teams.count === c.expectedTeamCount && s.teams.duplicateNames.length === 0, `${s.teams.count} teams, no duplicate names.`,
    s.teams.duplicateNames.length > 0 ? `Duplicate team names: ${s.teams.duplicateNames.join(", ")}.` : `${s.teams.count} teams synced, expected ${c.expectedTeamCount}.`));

  items.push(item("fixtures-present", "Upcoming Games present", s.fixtures.upcomingNext14d > 0 && s.fixtures.duplicateExternalIds === 0, `${s.fixtures.upcomingNext14d} upcoming Games in the next 14 days; no duplicate provider ids.`,
    s.fixtures.duplicateExternalIds > 0 ? `${s.fixtures.duplicateExternalIds} duplicate provider game ids.` : `No upcoming Games in the next 14 days (${s.fixtures.total} Games stored in total).`));

  const w = s.inventory.withoutMarket;
  const withoutMarket = s.inventory.upcomingInOddsWindow - s.inventory.withActiveMarket;
  const providerSide = w.providerHasNoOdds + w.providerInsufficientBookmakers;
  const platformSide = w.providerErrored + w.notExamined;
  const allExplainedByProvider = withoutMarket > 0 && platformSide === 0 && providerSide === withoutMarket;
  const providerWords = `the provider has published no odds for ${w.providerHasNoOdds} and too few bookmakers for ${w.providerInsufficientBookmakers}`;
  const marketsStatus: ReadinessStatus =
    s.inventory.marketsWithBadShape > 0 ? "FAIL"
    : s.inventory.upcomingInOddsWindow === 0 ? "PROOF_PENDING"
    : withoutMarket === 0 ? "PASS"
    : platformSide > 0 ? "FAIL"
    : allExplainedByProvider && s.inventory.withActiveMarket > 0 ? "PASS" // Games the provider has not priced yet are not a defect when the rest are Marketed
    : allExplainedByProvider ? "PROVIDER_INVENTORY_UNAVAILABLE"
    : "FAIL";
  items.push({
    id: "markets-present", label: "Markets present for upcoming Games", status: marketsStatus,
    detail:
      s.inventory.marketsWithBadShape > 0 ? `${s.inventory.marketsWithBadShape} Markets would be ungradeable.`
      : s.inventory.upcomingInOddsWindow === 0 ? "No upcoming Game inside the odds window yet — nothing to prove Markets against."
      : withoutMarket === 0 ? `${s.inventory.withActiveMarket}/${s.inventory.upcomingInOddsWindow} upcoming Games inside the odds window have an ACTIVE Market; every Market is gradeable.`
      : w.providerErrored > 0 ? `${w.providerErrored} Game(s) inside the odds window had an odds request that ERRORED (not "no odds") — see the ingest job.`
      : w.notExamined > 0 ? `${w.notExamined} Game(s) inside the odds window were not examined by the latest ingestion run and have no ACTIVE Market.`
      : marketsStatus === "PASS" ? `${s.inventory.withActiveMarket}/${s.inventory.upcomingInOddsWindow} inside the odds window have an ACTIVE Market; for the other ${withoutMarket}, ${providerWords} yet.`
      : `Provider inventory unavailable: ${providerWords}. The platform asked and is healthy; Markets appear when the provider publishes odds.`,
  });

  const unpublished = s.inventory.withActiveMarket - s.inventory.withActiveMarketAndPublishedPost;
  const noMarketsYet: ReadinessStatus = marketsStatus === "PROVIDER_INVENTORY_UNAVAILABLE" || marketsStatus === "PROOF_PENDING" ? marketsStatus : "FAIL";
  items.push(item("posts-present", "Posts published (one per Game)", unpublished === 0 && s.inventory.withActiveMarket > 0 && s.inventory.duplicatePosts === 0, `${s.inventory.withActiveMarketAndPublishedPost}/${s.inventory.withActiveMarket} Games with a Market have a published Post; no Game has two Posts.`,
    s.inventory.duplicatePosts > 0 ? `${s.inventory.duplicatePosts} Games have more than one Post.` : s.inventory.withActiveMarket === 0 ? "No Games with a Market to publish yet." : `${unpublished} Game(s) with a Market have no published Post.`,
    s.inventory.duplicatePosts === 0 && s.inventory.withActiveMarket === 0 ? noMarketsYet : "FAIL"));

  items.push(item("provider-results", "Provider result path proven (completed Games carry scores)", s.fixtures.completedWithScores > 0, `${s.fixtures.completedWithScores} COMPLETED Games with both scores stored.`,
    "No COMPLETED Game with scores yet — the result path has not been exercised on real provider data.", "PROOF_PENDING"));

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
    .filter((h) => h.status !== "healthy" && h.status !== "no_op_healthy")
    .filter((h) => !(h.status === "degraded" && failuresBelongToOtherSports(s.jobs, h.job.id, c.sport))); // per-sport isolation: another sport's failure is not this sport's
  items.push(item("jobs-healthy", "Jobs healthy", unhealthy.length === 0, "Fixture sync, odds ingestion, publication, distribution, grading, Call BS resolution and settlement all ran recently without failures attributable to this sport.",
    `Not healthy: ${unhealthy.map((h) => `${h.job.id} (${h.status}${h.lastError ? `: ${h.lastError}` : ""})`).join(", ")}.`));

  items.push(item("feed", "Feed rendering (published Posts with a Market)", s.inventory.withActiveMarketAndPublishedPost > 0, `${s.inventory.withActiveMarketAndPublishedPost} Posts with an ACTIVE Market are eligible for the feed.`,
    "No published Post with an ACTIVE Market — the sport's feed is empty.", s.inventory.withActiveMarket === 0 ? noMarketsYet : "FAIL"));

  items.push(item("notifications", "Notifications enabled", s.notificationsEnabled, "Prediction result notifications are enabled.", "prediction_notifications_enabled is off — members would not be told their Picks were graded."));

  return items;
}

/** The one overall answer. DISABLED (switched off) beats everything; then a real defect; then a missing provider inventory; then proof that cannot exist yet. */
export function overallVerdict(items: readonly ReadinessItem[]): ReadinessVerdict {
  const has = (status: ReadinessStatus) => items.some((i) => i.status === status);
  if (has("DISABLED")) return "DISABLED";
  if (has("FAIL")) return "BROKEN";
  if (has("PROVIDER_INVENTORY_UNAVAILABLE")) return "PROVIDER_INVENTORY_UNAVAILABLE";
  if (has("PROOF_PENDING")) return "PROOF_PENDING";
  return "HEALTHY";
}

const VERDICT_TEXT: Record<ReadinessVerdict, (label: string, failing: number) => string> = {
  HEALTHY: (l) => `${l}: PRODUCTION READY`,
  BROKEN: (l, n) => `${l}: NOT READY — BROKEN (${n} item${n === 1 ? "" : "s"} failing)`,
  DISABLED: (l) => `${l}: DISABLED (switched off by configuration — nothing else is judged)`,
  PROVIDER_INVENTORY_UNAVAILABLE: (l) => `${l}: PROVIDER INVENTORY UNAVAILABLE (the platform is healthy; the provider has not published the data yet)`,
  PROOF_PENDING: (l) => `${l}: PRODUCTION PROOF PENDING (nothing is broken; real-data proof cannot exist yet)`,
};

export function formatReadiness(config: SportConfig, items: ReadinessItem[]): string {
  const width = Math.max(...items.map((i) => i.label.length));
  const statusWidth = Math.max(...items.map((i) => i.status.length));
  const lines = items.map((i) => `${i.status.padEnd(statusWidth)}  ${i.label.padEnd(width)}  ${i.detail}`);
  const failed = items.filter((i) => i.status === "FAIL").length;
  return [`${config.label} readiness`, ...lines, "", VERDICT_TEXT[overallVerdict(items)](config.label, failed)].join("\n");
}
