import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import { fetchInChunks } from "@/lib/utils/batch";
import { computeGameContexts, eligibleTarget } from "./compute";
import { DISABLED_GAME_CONTEXT, parseGameContextConfig } from "./config";
import type { ContextFixture, GameContext, GameContextConfig } from "./types";

// Brohda 2.1 M3 — the one place Game Context touches the database. READ-ONLY: three reads however many Games are asked about (settings, the Games themselves, their teams' regular-season history),
// then everything is computed in memory by ./compute.ts. Never writes, never calls anything outside the database, and never lets a failure reach the caller as anything but "no context".

const FIXTURE_COLUMNS = "id, provider, sport, season, round, home_team_external_id, away_team_external_id, home_team_name, away_team_name, scheduled_start_utc, internal_status, home_score, away_score";
// Under PostgREST's 1,000-row response ceiling (which truncates silently): a short page therefore reliably means "the end".
const HISTORY_PAGE = 900;
// Team ids per history query: keeps the filter well inside URL limits (an NFL league has 32 teams, so one query).
const TEAMS_PER_QUERY = 60;
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;

interface FixtureRow {
  id: string;
  provider: string;
  sport: string;
  season: string | null;
  round: string | null;
  home_team_external_id: string | null;
  away_team_external_id: string | null;
  home_team_name: string;
  away_team_name: string;
  scheduled_start_utc: string;
  internal_status: string;
  home_score: number | null;
  away_score: number | null;
}

const toContextFixture = (r: FixtureRow): ContextFixture => ({
  id: r.id,
  provider: r.provider,
  sport: r.sport,
  season: r.season,
  round: r.round,
  homeTeamExternalId: r.home_team_external_id,
  awayTeamExternalId: r.away_team_external_id,
  homeTeamName: r.home_team_name,
  awayTeamName: r.away_team_name,
  scheduledStartUtc: r.scheduled_start_utc,
  internalStatus: r.internal_status,
  homeScore: r.home_score,
  awayScore: r.away_score,
});

export async function getGameContextConfig(): Promise<GameContextConfig> {
  const { data, error } = await createAdminClient().from("platform_settings").select("game_context_enabled, game_context_config").eq("id", true).maybeSingle();
  if (error) return DISABLED_GAME_CONTEXT;
  return parseGameContextConfig(data);
}

/**
 * For the Super Admin card only: the stored thresholds even while the feature is OFF (the runtime parser answers "defaults" when it is off), with `enabled` showing the real switch.
 * A stored config that does not parse shows the defaults and `enabled: false`, which is also what the feed does with it.
 */
export async function getGameContextPolicyForAdmin(): Promise<GameContextConfig> {
  const { data } = await createAdminClient().from("platform_settings").select("game_context_enabled, game_context_config").eq("id", true).maybeSingle();
  const parsed = parseGameContextConfig({ game_context_enabled: true, game_context_config: data?.game_context_config ?? null });
  return { ...parsed, enabled: parsed.enabled && data?.game_context_enabled === true };
}

export interface LoadStats {
  /** Database round trips made (settings included). */
  queries: number;
  /** Rows read from `fixtures` (targets plus history). */
  rows: number;
  targets: number;
  /** Games that ended up with a line. */
  withContext: number;
}

/** Same as getGameContexts, but with the policy supplied and the cost reported — the seam the performance test and the staging evaluation use. */
export async function loadGameContexts(fixtureIds: readonly string[], config: GameContextConfig): Promise<{ contexts: Map<string, GameContext>; stats: LoadStats }> {
  const stats: LoadStats = { queries: 0, rows: 0, targets: 0, withContext: 0 };
  const contexts = new Map<string, GameContext>();
  const ids = [...new Set(fixtureIds)];
  if (!config.enabled || ids.length === 0) return { contexts, stats };
  const admin = createAdminClient();

  const targetRows = await fetchInChunks<FixtureRow>(ids, (chunk) => {
    stats.queries++;
    return admin.from("fixtures").select(FIXTURE_COLUMNS).in("id", chunk);
  });
  stats.rows += targetRows.length;
  // Only Games Game Context can speak about are worth a history read: eligibility is the same check the computation makes.
  const targets = targetRows.map(toContextFixture).filter((t) => eligibleTarget(t) !== null);
  stats.targets = targets.length;
  if (targets.length === 0) return { contexts, stats };

  // One history read per (provider, season): the regular-season Games of every team that appears, up to the latest target.
  const groups = new Map<string, { provider: string; sport: string; season: string; prefix: string; teams: Set<string>; latest: number }>();
  for (const t of targets) {
    const e = eligibleTarget(t)!;
    const prefix = getSportConfig(t.sport)!.regularSeason!.roundPrefix;
    const key = `${t.provider}|${t.sport}|${e.season}`;
    const g = groups.get(key) ?? { provider: t.provider, sport: t.sport, season: e.season, prefix, teams: new Set<string>(), latest: 0 };
    for (const team of [e.homeId, e.awayId]) if (SAFE_ID.test(team)) g.teams.add(team);
    g.latest = Math.max(g.latest, Date.parse(t.scheduledStartUtc));
    groups.set(key, g);
  }

  const history = new Map<string, ContextFixture>();
  for (const g of groups.values()) {
    const teams = [...g.teams].sort();
    for (let i = 0; i < teams.length; i += TEAMS_PER_QUERY) {
      const list = teams.slice(i, i + TEAMS_PER_QUERY).join(",");
      for (let from = 0; ; from += HISTORY_PAGE) {
        stats.queries++;
        const { data, error } = await admin
          .from("fixtures")
          .select(FIXTURE_COLUMNS)
          .eq("provider", g.provider)
          .eq("sport", g.sport)
          .eq("season", g.season)
          .like("round", `${g.prefix}%`)
          .lt("scheduled_start_utc", new Date(g.latest).toISOString())
          .or(`home_team_external_id.in.(${list}),away_team_external_id.in.(${list})`)
          .order("scheduled_start_utc", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + HISTORY_PAGE - 1);
        if (error) throw error;
        const page = (data ?? []) as FixtureRow[];
        stats.rows += page.length;
        for (const row of page) history.set(row.id, toContextFixture(row));
        if (page.length < HISTORY_PAGE) break;
      }
    }
  }

  for (const [id, context] of computeGameContexts(targets, [...history.values()], config)) contexts.set(id, context);
  stats.withContext = contexts.size;
  return { contexts, stats };
}

/**
 * The Game Context lines for these Games, keyed by fixture id (Games without a line are simply absent). Feed and Post both call this, so the same Game never reads two ways.
 * ANY failure — settings unreadable, a query error, a bug — is logged and answered with "no context": the Game, its Picks, Confidence and Call BS never depend on this.
 */
export async function getGameContexts(fixtureIds: readonly string[]): Promise<Map<string, GameContext>> {
  try {
    const config = await getGameContextConfig();
    if (!config.enabled) return new Map();
    return (await loadGameContexts(fixtureIds, config)).contexts;
  } catch (error) {
    console.error("[game-context] failed; showing no context", JSON.stringify({ message: error instanceof Error ? error.message : String(error), games: fixtureIds.length }));
    return new Map();
  }
}
