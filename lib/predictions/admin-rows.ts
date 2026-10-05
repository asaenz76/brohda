import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInChunks } from "@/lib/utils/batch";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";

// Read-only, operator-facing view model for /admin/predictions: each
// Prediction with the human context an operator needs (who, which Game,
// which Market) next to the raw ids, resolved in batches — predictions, then
// profiles + markets in parallel, then fixtures — never one lookup per row. Nothing here writes, regrades or interprets a
// Prediction; it only reads and labels.

export const ADMIN_PREDICTIONS_LIMIT = 200;

export interface AdminPredictionRaw {
  id: string;
  user_id: string;
  market_id: string;
  selected_outcome: string;
  yes_probability_snapshot: number | string;
  no_probability_snapshot: number | string;
  lifecycle_state: string;
  result: string | null;
  graded_at: string | null;
  created_at: string;
}
export interface AdminProfileRaw {
  id: string;
  username: string | null;
  display_name: string | null;
}
export interface AdminMarketRaw {
  id: string;
  question: string | null;
  fixture_id: string | null;
}
export interface AdminFixtureRaw {
  id: string;
  sport: string;
  home_team_name: string;
  away_team_name: string;
}

export interface AdminPredictionRow {
  id: string;
  createdAt: string;
  selectedOutcome: string;
  yesPercent: number;
  noPercent: number;
  lifecycleState: string;
  result: string | null;
  gradedAt: string | null;
  user: { id: string; shortId: string; primary: string; known: boolean };
  match: { primary: string; known: boolean };
  market: { id: string; shortId: string; primary: string; known: boolean };
}

export const shortId = (id: string) => id.slice(0, 8);

/**
 * Pure mapping from the raw batches to display rows. A missing profile,
 * Market or Game degrades to "Unknown …" (the raw id stays visible in the
 * row) rather than throwing, so a legacy or orphaned row never takes the
 * page down. The username comes from user_profiles.username, the same
 * column the session and public profile routes read; the display name is
 * only a fallback when no username was ever set.
 */
export function buildAdminPredictionRows(input: {
  predictions: AdminPredictionRaw[];
  profiles: AdminProfileRaw[];
  markets: AdminMarketRaw[];
  fixtures: AdminFixtureRaw[];
}): AdminPredictionRow[] {
  const profileById = new Map(input.profiles.map((p) => [p.id, p]));
  const marketById = new Map(input.markets.map((m) => [m.id, m]));
  const fixtureById = new Map(input.fixtures.map((f) => [f.id, f]));

  return input.predictions.map((p) => {
    const profile = profileById.get(p.user_id);
    const userLabel = profile?.username?.trim() || profile?.display_name?.trim() || null;

    const market = marketById.get(p.market_id);
    const fixture = market?.fixture_id ? fixtureById.get(market.fixture_id) : undefined;
    const matchLabel = fixture
      ? (() => {
          const [first, second] = orderTeamsForDisplay(fixture.sport, fixture.home_team_name, fixture.away_team_name);
          return `${first} ${getMatchupSeparator(fixture.sport)} ${second}`;
        })()
      : null;
    const question = market?.question?.trim() || null;

    return {
      id: p.id,
      createdAt: p.created_at,
      selectedOutcome: p.selected_outcome,
      yesPercent: Math.round(Number(p.yes_probability_snapshot) * 100),
      noPercent: Math.round(Number(p.no_probability_snapshot) * 100),
      lifecycleState: p.lifecycle_state,
      result: p.result,
      gradedAt: p.graded_at,
      user: { id: p.user_id, shortId: shortId(p.user_id), primary: userLabel ?? "Unknown user", known: userLabel !== null },
      match: { primary: matchLabel ?? "Unknown game", known: matchLabel !== null },
      market: { id: p.market_id, shortId: shortId(p.market_id), primary: question ?? "Unknown market", known: question !== null },
    };
  });
}

type AdminClient = Pick<ReturnType<typeof createAdminClient>, "from">;

/** The most recent Predictions with their user, Game and Market resolved in batches. `client` is injectable so tests can count queries. */
export async function listAdminPredictionRows(limit: number = ADMIN_PREDICTIONS_LIMIT, client: AdminClient = createAdminClient()): Promise<AdminPredictionRow[]> {
  const { data: predictions, error } = await client
    .from("predictions")
    .select("id, user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, lifecycle_state, result, graded_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (predictions ?? []) as AdminPredictionRaw[];
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const marketIds = [...new Set(rows.map((r) => r.market_id))];

  // Id lists go through fetchInChunks: a single .in() with a few hundred UUIDs exceeds PostgREST's URL limit ("URI too long").
  // Reads stay bounded (one per ~150 ids per table), never one per row. An error in any chunk is thrown, not swallowed into
  // "Unknown ..." rows.
  const readChunk = <Row,>(table: string, columns: string) => (chunk: string[]) =>
    client
      .from(table)
      .select(columns)
      .in("id", chunk)
      .then((result: { data: unknown; error: { message: string } | null }) => {
        if (result.error) throw result.error;
        return { data: result.data as Row[] | null };
      });

  const [profiles, markets] = await Promise.all([
    fetchInChunks<AdminProfileRaw>(userIds, readChunk<AdminProfileRaw>("user_profiles", "id, username, display_name")),
    fetchInChunks<AdminMarketRaw>(marketIds, readChunk<AdminMarketRaw>("markets", "id, question, fixture_id")),
  ]);

  const fixtureIds = [...new Set(markets.map((m) => m.fixture_id).filter((id): id is string => Boolean(id)))];
  const fixtures = await fetchInChunks<AdminFixtureRaw>(fixtureIds, readChunk<AdminFixtureRaw>("fixtures", "id, sport, home_team_name, away_team_name"));

  return buildAdminPredictionRows({ predictions: rows, profiles, markets, fixtures });
}
