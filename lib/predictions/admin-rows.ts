import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInChunks } from "@/lib/utils/batch";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";

// Read-only, operator-facing view model for /admin/predictions: each
// Prediction with the human context an operator needs (who, which Game,
// which Market) next to the raw ids, resolved in batches — predictions, then
// profiles + markets in parallel, then fixtures — never one lookup per row. Nothing here writes, regrades or interprets a
// Prediction; it only reads and labels.

export const ADMIN_PREDICTIONS_LIMIT = 200;

// ---- Search / filter -------------------------------------------------------------------------------------------------------------
export const ADMIN_PREDICTION_STATES = ["PENDING", "GRADED"] as const;
export const ADMIN_PREDICTION_RESULTS = ["CORRECT", "INCORRECT", "VOID", "NONE"] as const; // NONE = not graded yet
export const ADMIN_SEARCH_MAX_LENGTH = 100;

export interface AdminPredictionFilters {
  /** Free text: username / display name / user id / Prediction id / Market id (ids by prefix, so the short ids shown work) / team / Market question. */
  query?: string;
  state?: (typeof ADMIN_PREDICTION_STATES)[number];
  result?: (typeof ADMIN_PREDICTION_RESULTS)[number];
  /** Inclusive UTC calendar dates, "YYYY-MM-DD". */
  from?: string;
  to?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Reads the filters out of a page's search params. Anything unrecognised or malformed is dropped (never passed on), so a bad URL just means "no filter". */
export function parseAdminPredictionFilters(params: Record<string, string | string[] | undefined>): AdminPredictionFilters {
  const filters: AdminPredictionFilters = {};
  const query = first(params.q)?.trim().slice(0, ADMIN_SEARCH_MAX_LENGTH);
  if (query) filters.query = query;
  const state = first(params.state);
  if ((ADMIN_PREDICTION_STATES as readonly string[]).includes(state ?? "")) filters.state = state as AdminPredictionFilters["state"];
  const result = first(params.result);
  if ((ADMIN_PREDICTION_RESULTS as readonly string[]).includes(result ?? "")) filters.result = result as AdminPredictionFilters["result"];
  for (const key of ["from", "to"] as const) {
    const value = first(params[key]);
    if (value && DATE_ONLY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) filters[key] = value;
  }
  return filters;
}

export const hasActiveAdminPredictionFilters = (f: AdminPredictionFilters) => Boolean(f.query || f.state || f.result || f.from || f.to);

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
  market_template?: "MONEYLINE" | "SPREAD" | "TOTAL" | null;
  line_value?: number | string | null;
  yes_side?: "HOME" | "AWAY" | null;
  price_outcome_labels?: { yes?: string | null; no?: string | null } | null;
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
  /** The canonical stored selection ("YES" | "NO") — kept for diagnostics. */
  selectedOutcome: string;
  /** What the person actually picked, as the Game reads it ("Washington Commanders"); null when the Market can't be described. */
  selectedLabel: string | null;
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
    const matchLabel = fixture ? formatMatchup(fixture.sport, fixture.home_team_name, fixture.away_team_name) : null;
    const presentation = market
      ? getChoicePresentation({
          marketTemplate: market.market_template ?? null,
          lineValue: market.line_value != null ? Number(market.line_value) : null,
          yesSide: market.yes_side ?? null,
          homeTeamName: fixture?.home_team_name ?? null,
          awayTeamName: fixture?.away_team_name ?? null,
          sport: fixture?.sport ?? null,
          priceOutcomeLabels: market.price_outcome_labels ? { yes: market.price_outcome_labels.yes ?? null, no: market.price_outcome_labels.no ?? null } : null,
        })
      : null;
    const selectedLabel = presentation?.templateAware ? (presentation.choices.find((c) => c.outcome === p.selected_outcome)?.label ?? null) : null;
    const question = market?.question?.trim() || null;

    return {
      id: p.id,
      createdAt: p.created_at,
      selectedOutcome: p.selected_outcome,
      selectedLabel,
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

type AdminClient = Pick<ReturnType<typeof createAdminClient>, "from"> & Partial<Pick<ReturnType<typeof createAdminClient>, "rpc">>;

/** The most recent Predictions with their user, Game and Market resolved in batches. `client` is injectable so tests can count queries. */
export async function listAdminPredictionRows(
  limit: number = ADMIN_PREDICTIONS_LIMIT,
  client: AdminClient = createAdminClient(),
  filters: AdminPredictionFilters = {},
): Promise<AdminPredictionRow[]> {
  const columns = "id, user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, lifecycle_state, result, graded_at, created_at";
  let rows: AdminPredictionRaw[];
  if (hasActiveAdminPredictionFilters(filters)) {
    // Filtered: one bounded server-side search for the matching ids (real joins, literal matching), then the same batched row loading as
    // the unfiltered view — no per-row lookups, and never a client-side filter over an unbounded table.
    if (!client.rpc) throw new Error("admin prediction search needs an RPC-capable client");
    const { data: ids, error: searchError } = await client.rpc("admin_search_predictions", {
      p_query: filters.query ?? null,
      p_state: filters.state ?? null,
      p_result: filters.result ?? null,
      p_from: filters.from ?? null,
      p_to: filters.to ?? null,
      p_limit: limit,
    });
    if (searchError) throw searchError;
    const matched = ((ids ?? []) as string[]).map(String);
    if (matched.length === 0) return [];
    const loaded = await fetchInChunks<AdminPredictionRaw>(matched, (chunk) =>
      client
        .from("predictions")
        .select(columns)
        .in("id", chunk)
        .then((result: { data: unknown; error: { message: string } | null }) => {
          if (result.error) throw result.error;
          return { data: result.data as AdminPredictionRaw[] | null };
        }),
    );
    rows = loaded.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  } else {
    const { data: predictions, error } = await client.from("predictions").select(columns).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    rows = (predictions ?? []) as AdminPredictionRaw[];
  }
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
    fetchInChunks<AdminMarketRaw>(marketIds, readChunk<AdminMarketRaw>("markets", "id, question, fixture_id, market_template, line_value, yes_side, price_outcome_labels")),
  ]);

  const fixtureIds = [...new Set(markets.map((m) => m.fixture_id).filter((id): id is string => Boolean(id)))];
  const fixtures = await fetchInChunks<AdminFixtureRaw>(fixtureIds, readChunk<AdminFixtureRaw>("fixtures", "id, sport, home_team_name, away_team_name"));

  return buildAdminPredictionRows({ predictions: rows, profiles, markets, fixtures });
}
