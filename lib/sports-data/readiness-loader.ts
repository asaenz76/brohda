import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, fetchInChunks } from "@/lib/utils/batch";
import { getCurrentSportsbookWeek } from "./sportsbook-week";
import { getOddsProvider } from "./provider-registry";
import type { BackgroundJobRow } from "@/lib/jobs/health";
import type { ReadinessSnapshot } from "./readiness";
import { isSportActive, type SportConfig } from "./sport-registry";

// A usable logo is a provider https URL or a self-hosted root-relative asset (the NFL league logo is self-hosted: its CDN copy was unreliable).
const isHttps = (url: string | null | undefined) => typeof url === "string" && (url.startsWith("https://") || /^\/[^/]/.test(url));

/** Reads the readiness facts for one sport from the database. Read-only: no provider calls, no writes. Safe against production. */
export async function loadReadinessSnapshot(config: SportConfig, now: Date = new Date(), env: Record<string, string | undefined> = process.env): Promise<ReadinessSnapshot> {
  const admin = createAdminClient();

  // "Enabled" is judged from this process's environment AND from evidence: a provider that made requests in the last 24h is demonstrably on in
  // the deployed app (a script run from a laptop doesn't see Vercel's environment).
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { count: recentRequests } = await admin.from("provider_request_log").select("id", { count: "exact", head: true }).eq("provider", config.provider).gte("created_at", since);
  const keyConfigured = Boolean(env[`${config.envPrefix}_KEY`] || env.API_SPORTS_KEY || env.API_NFL_KEY) || (recentRequests ?? 0) > 0;
  const enabled = isSportActive(config, env) || (recentRequests ?? 0) > 0;

  const [{ data: teams }, { data: leagues }] = await Promise.all([
    admin.from("teams").select("id, name, logo_url").eq("provider", config.provider),
    admin.from("leagues").select("id, name, logo_url").eq("provider", config.provider),
  ]);
  const teamRows = teams ?? [];
  const leagueRows = leagues ?? [];
  const nameCounts = new Map<string, number>();
  for (const t of teamRows) nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);

  const teamIds = teamRows.map((t) => t.id as string);
  const leagueIds = leagueRows.map((l) => l.id as string);
  const teamCommunities = await fetchInChunks<{ team_id: string; slug: string }>(teamIds, (chunk) => admin.from("communities").select("team_id, slug").eq("type", "TEAM").in("team_id", chunk));
  const perTeam = new Map<string, number>();
  for (const cm of teamCommunities) perTeam.set(cm.team_id, (perTeam.get(cm.team_id) ?? 0) + 1);
  const leagueCommunities = await fetchInChunks<{ id: string; slug: string }>(leagueIds, (chunk) => admin.from("communities").select("id, slug").eq("type", "LEAGUE").in("league_id", chunk));
  const { data: sportCommunities } = await admin.from("communities").select("id, slug").eq("type", "SPORT").eq("sport_key", config.sport);
  const slugs = [...teamCommunities.map((c) => c.slug), ...leagueCommunities.map((c) => c.slug), ...(sportCommunities ?? []).map((c) => c.slug)];

  const fixtures = await fetchAllRows((from, to) =>
    admin.from("fixtures").select("id, external_fixture_id, internal_status, scheduled_start_utc, home_score, away_score").eq("provider", config.provider).order("id").range(from, to),
  );
  const externalIdCounts = new Map<string, number>();
  for (const f of fixtures) externalIdCounts.set(f.external_fixture_id, (externalIdCounts.get(f.external_fixture_id) ?? 0) + 1);
  const horizon14 = new Date(now.getTime() + 14 * 86_400_000);
  const upcoming = fixtures.filter((f) => f.internal_status === "NOT_STARTED" && new Date(f.scheduled_start_utc) > now);
  const completedWithScores = fixtures.filter((f) => f.internal_status === "COMPLETED" && f.home_score !== null && f.away_score !== null);

  const windowEnd = config.oddsWindow.kind === "sportsbook-week" ? new Date(getCurrentSportsbookWeek(now).weekEndUtc) : new Date(now.getTime() + config.oddsWindow.hours * 3_600_000);
  const inWindow = upcoming.filter((f) => new Date(f.scheduled_start_utc) < windowEnd).map((f) => f.id as string);
  const markets = await fetchInChunks<{ fixture_id: string; market_template: string; line_value: number | null; yes_side: string | null }>(inWindow, (chunk) =>
    admin.from("markets").select("fixture_id, market_template, line_value, yes_side").in("fixture_id", chunk).eq("status", "ACTIVE"),
  );
  const withMarket = new Set(markets.map((m) => m.fixture_id));
  const posts = await fetchInChunks<{ fixture_id: string; published_at: string | null }>([...withMarket], (chunk) => admin.from("posts").select("fixture_id, published_at").in("fixture_id", chunk));
  const publishedFor = new Set(posts.filter((p) => p.published_at !== null).map((p) => p.fixture_id));
  const postCounts = new Map<string, number>();
  for (const p of posts) postCounts.set(p.fixture_id, (postCounts.get(p.fixture_id) ?? 0) + 1);
  const badShape = markets.filter((m) => (m.market_template === "MONEYLINE" && (m.yes_side === null || m.line_value !== null)) || (m.market_template === "SPREAD" && (m.yes_side === null || m.line_value === null)) || (m.market_template === "TOTAL" && (m.yes_side !== null || m.line_value === null)));

  const { data: jobs } = await admin.from("background_jobs").select("job_name, status, result, error, started_at, finished_at, duration_ms").order("finished_at", { ascending: false }).limit(300);
  const { data: settings } = await admin.from("platform_settings").select("job_staleness_multiplier, prediction_notifications_enabled").eq("id", true).single();

  return {
    now,
    config,
    enabled,
    keyConfigured,
    adapterRegistered: getOddsProvider(config.provider) !== null,
    teams: { count: teamRows.length, withoutHttpsLogo: teamRows.filter((t) => !isHttps(t.logo_url)).length, duplicateNames: [...nameCounts].filter(([, n]) => n > 1).map(([name]) => name) },
    leagues: { count: leagueRows.length, withoutHttpsLogo: leagueRows.filter((l) => !isHttps(l.logo_url)).length },
    communities: {
      teamsWithoutCommunity: teamIds.filter((id) => !perTeam.has(id)).length,
      teamsWithDuplicateCommunity: [...perTeam.values()].filter((n) => n > 1).length,
      leagueCommunity: leagueCommunities.length > 0,
      sportCommunity: (sportCommunities ?? []).length > 0,
      duplicateSlugs: slugs.length - new Set(slugs).size,
    },
    fixtures: {
      total: fixtures.length,
      duplicateExternalIds: [...externalIdCounts.values()].filter((n) => n > 1).length,
      upcomingNext14d: upcoming.filter((f) => new Date(f.scheduled_start_utc) < horizon14).length,
      completedWithScores: completedWithScores.length,
      completedLevelInNoTieSport: config.tiesPossible ? 0 : completedWithScores.filter((f) => f.home_score === f.away_score).length,
    },
    inventory: {
      upcomingInOddsWindow: inWindow.length,
      withActiveMarket: withMarket.size,
      withActiveMarketAndPublishedPost: [...withMarket].filter((id) => publishedFor.has(id)).length,
      duplicatePosts: [...postCounts.values()].filter((n) => n > 1).length,
      marketsWithBadShape: badShape.length,
    },
    jobs: (jobs ?? []) as BackgroundJobRow[],
    stalenessMultiplier: settings?.job_staleness_multiplier ?? 3,
    notificationsEnabled: settings?.prediction_notifications_enabled ?? false,
  };
}
