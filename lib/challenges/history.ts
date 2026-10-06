import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInChunks } from "@/lib/utils/batch";
import { listPostIdsForFixtures } from "@/lib/predictions/post-links";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import type { PredictionOutcome } from "@/lib/predictions/types";
import type { ChallengeResult } from "./types";

// Call BS as a lasting social record: who beat whom, on which Game. Every
// number here is derived from canonical RESOLVED challenge rows at read time
// — there is no stored counter to drift, no score, no rating. Only free Call
// BS is read; monetary Positions are a different layer and never appear.
//
// The overall W-L is the existing get_call_bs_record RPC (lib/reputation/
// repository.ts getUserCallBsRecord), which applies the locked reputation
// rule "one Pick contributes at most one Call BS result against the same
// opponent". The pair-specific head-to-head below applies the same rule, so
// the two always agree. The history list is the raw social history (each
// resolved challenge once), newest resolution first.

/** How many recent resolved Call BS challenges the Profile shows. A presentation size, not product policy. */
export const CALL_BS_PROFILE_HISTORY_LIMIT = 5;

export type CallBsOutcome = "WON" | "LOST" | "VOID";

export interface ResolvedChallengeRow {
  id: string;
  market_id: string;
  challenger_user_id: string;
  recipient_user_id: string;
  challenger_prediction_id: string;
  recipient_prediction_id: string;
  challenger_selection_snapshot: PredictionOutcome;
  recipient_selection_snapshot: PredictionOutcome;
  result: ChallengeResult | null;
  resolved_at: string | null;
}

export interface HeadToHeadRecord {
  wins: number;
  losses: number;
  voids: number;
}

const EMPTY_RECORD: HeadToHeadRecord = { wins: 0, losses: 0, voids: 0 };

/** The result of one resolved challenge from `userId`'s side — decided only from the stored winner, never from a current Pick, a comment or a profile. */
export function outcomeForUser(row: Pick<ResolvedChallengeRow, "challenger_user_id" | "recipient_user_id" | "result">, userId: string): CallBsOutcome {
  if (row.result === "VOID" || row.result === null) return "VOID";
  const iAmChallenger = row.challenger_user_id === userId;
  if (iAmChallenger) return row.result === "CHALLENGER_WON" ? "WON" : "LOST";
  return row.result === "RECIPIENT_WON" ? "WON" : "LOST";
}

const myPickId = (row: ResolvedChallengeRow, userId: string) => (row.challenger_user_id === userId ? row.challenger_prediction_id : row.recipient_prediction_id);

/**
 * `viewerId`'s record against ONE opponent, from the viewer's perspective:
 * the same underlying challenges read from the opponent's side give the
 * mirror image. Applies the locked dedup rule (one counted result per of
 * the viewer's Picks per opponent) so a Pick that was challenged and
 * resolved repeatedly still counts once. Pure; rows must already be limited
 * to this pair and to RESOLVED.
 */
export function computeHeadToHead(rows: ResolvedChallengeRow[], viewerId: string): HeadToHeadRecord {
  const byPick = new Map<string, CallBsOutcome>();
  for (const row of rows) {
    const key = myPickId(row, viewerId);
    const outcome = outcomeForUser(row, viewerId);
    // Same pick against the same opponent can only ever resolve one way; keep the first deterministically.
    if (!byPick.has(key)) byPick.set(key, outcome);
  }
  const record = { ...EMPTY_RECORD };
  for (const outcome of byPick.values()) {
    if (outcome === "WON") record.wins += 1;
    else if (outcome === "LOST") record.losses += 1;
    else record.voids += 1;
  }
  return record;
}

/**
 * `viewerId`'s head-to-head record against each of `opponentIds`, in two
 * batched reads per 150 opponents (one per direction) — never one read per
 * opponent. Only RESOLVED challenges count: a pending or accepted-but-not-yet-
 * graded one is deliberately invisible until it resolves.
 */
type AdminClient = Pick<ReturnType<typeof createAdminClient>, "from">;

export async function getHeadToHeadRecords(viewerId: string, opponentIds: string[], client: AdminClient = createAdminClient()): Promise<Map<string, HeadToHeadRecord>> {
  const unique = [...new Set(opponentIds)].filter((id) => id !== viewerId);
  const result = new Map<string, HeadToHeadRecord>();
  if (unique.length === 0) return result;

  const admin = client;
  const columns = "id, market_id, challenger_user_id, recipient_user_id, challenger_prediction_id, recipient_prediction_id, challenger_selection_snapshot, recipient_selection_snapshot, result, resolved_at";
  const read = (viewerColumn: "challenger_user_id" | "recipient_user_id", opponentColumn: "challenger_user_id" | "recipient_user_id") => (chunk: string[]) =>
    admin
      .from("challenges")
      .select(columns)
      .eq("status", "RESOLVED")
      .eq(viewerColumn, viewerId)
      .in(opponentColumn, chunk)
      .then((r) => {
        if (r.error) throw r.error;
        return { data: r.data as unknown as ResolvedChallengeRow[] | null };
      });

  const [asChallenger, asRecipient] = await Promise.all([
    fetchInChunks<ResolvedChallengeRow>(unique, read("challenger_user_id", "recipient_user_id")),
    fetchInChunks<ResolvedChallengeRow>(unique, read("recipient_user_id", "challenger_user_id")),
  ]);

  const grouped = new Map<string, ResolvedChallengeRow[]>();
  for (const row of [...asChallenger, ...asRecipient]) {
    const opponent = row.challenger_user_id === viewerId ? row.recipient_user_id : row.challenger_user_id;
    (grouped.get(opponent) ?? grouped.set(opponent, []).get(opponent)!).push(row);
  }
  for (const [opponent, rows] of grouped) result.set(opponent, computeHeadToHead(rows, viewerId));
  return result;
}

// ---- Recent history (the Profile's Call BS section) ----

export interface CallBsHistoryEntry {
  challengeId: string;
  outcome: CallBsOutcome;
  resolvedAt: string | null;
  opponent: { id: string; label: string; username: string | null; known: boolean };
  game: { label: string; known: boolean };
  /** The Market question, when the Market is still available — only context for a Market without a template-aware label. */
  question: string | null;
  /** "Moneyline" | "Spread" | "Total 47.5", when the Market has a template-aware label. */
  marketLabel: string | null;
  /** What `userId` picked, as the Game reads it ("Washington Commanders", "Patriots +3.5", "Over 47.5"). */
  pickLabel: string | null;
  /** What the opponent picked, the same way. */
  opponentPickLabel: string | null;
  /** The Game's canonical Post, when one is published — the destination every row links to. */
  postId: string | null;
}

export interface HistoryProfileRaw {
  id: string;
  username: string | null;
  display_name: string | null;
  is_active: boolean | null;
}
export interface HistoryMarketRaw {
  id: string;
  question: string | null;
  fixture_id: string | null;
  market_template?: "MONEYLINE" | "SPREAD" | "TOTAL" | null;
  line_value?: number | string | null;
  yes_side?: "HOME" | "AWAY" | null;
  price_outcome_labels: { yes?: string; no?: string } | null;
}
export interface HistoryFixtureRaw {
  id: string;
  sport: string;
  home_team_name: string;
  away_team_name: string;
}

/**
 * Pure mapping from the raw batches to display entries. An opponent whose
 * profile is gone or deactivated reads "Unavailable user", a Market or Game
 * that no longer resolves reads "Unavailable game" — the result and date
 * always remain.
 */
export function buildCallBsHistory(input: {
  rows: ResolvedChallengeRow[];
  userId: string;
  profiles: HistoryProfileRaw[];
  markets: HistoryMarketRaw[];
  fixtures: HistoryFixtureRaw[];
  postIdByFixtureId: Map<string, string>;
}): CallBsHistoryEntry[] {
  const profileById = new Map(input.profiles.map((p) => [p.id, p]));
  const marketById = new Map(input.markets.map((m) => [m.id, m]));
  const fixtureById = new Map(input.fixtures.map((f) => [f.id, f]));

  return input.rows.map((row) => {
    const opponentId = row.challenger_user_id === input.userId ? row.recipient_user_id : row.challenger_user_id;
    const profile = profileById.get(opponentId);
    const available = profile && profile.is_active !== false;
    const opponentLabel = available ? profile.display_name?.trim() || profile.username?.trim() || null : null;

    const market = marketById.get(row.market_id);
    const fixture = market?.fixture_id ? fixtureById.get(market.fixture_id) : undefined;
    const gameLabel = fixture ? formatMatchup(fixture.sport, fixture.home_team_name, fixture.away_team_name) : null;

    const mySnapshot = row.challenger_user_id === input.userId ? row.challenger_selection_snapshot : row.recipient_selection_snapshot;
    // The same shared presentation as the Post, the Profile history and the notifications: "You picked Bills", not "YES".
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
    const theirSnapshot = row.challenger_user_id === input.userId ? row.recipient_selection_snapshot : row.challenger_selection_snapshot;
    const pickLabel = presentation ? presentation.choices.find((c) => c.outcome === mySnapshot)!.label : null;
    const opponentPickLabel = presentation ? presentation.choices.find((c) => c.outcome === theirSnapshot)!.label : null;

    return {
      challengeId: row.id,
      outcome: outcomeForUser(row, input.userId),
      resolvedAt: row.resolved_at,
      opponent: { id: opponentId, label: opponentLabel ?? "Unavailable user", username: available ? profile.username : null, known: opponentLabel !== null },
      game: { label: gameLabel ?? "Unavailable game", known: gameLabel !== null },
      question: market?.question?.trim() || null,
      marketLabel: presentation?.marketLabel ?? null,
      pickLabel,
      opponentPickLabel,
      postId: market?.fixture_id ? (input.postIdByFixtureId.get(market.fixture_id) ?? null) : null,
    };
  });
}

/** `userId`'s most recent resolved Call BS challenges, newest resolution first, with opponent, Game and Market resolved in batches. */
export async function listCallBsHistory(userId: string, limit: number = CALL_BS_PROFILE_HISTORY_LIMIT, client: AdminClient = createAdminClient()): Promise<CallBsHistoryEntry[]> {
  const admin = client;
  const { data, error } = await admin
    .from("challenges")
    .select("id, market_id, challenger_user_id, recipient_user_id, challenger_prediction_id, recipient_prediction_id, challenger_selection_snapshot, recipient_selection_snapshot, result, resolved_at")
    .eq("status", "RESOLVED")
    .or(`challenger_user_id.eq.${userId},recipient_user_id.eq.${userId}`)
    .order("resolved_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as unknown as ResolvedChallengeRow[];
  if (rows.length === 0) return [];

  const opponentIds = [...new Set(rows.map((r) => (r.challenger_user_id === userId ? r.recipient_user_id : r.challenger_user_id)))];
  const marketIds = [...new Set(rows.map((r) => r.market_id))];
  const readChunk = <Row,>(table: string, columns: string) => (chunk: string[]) =>
    admin
      .from(table)
      .select(columns)
      .in("id", chunk)
      .then((r) => {
        if (r.error) throw r.error;
        return { data: r.data as unknown as Row[] | null };
      });

  const [profiles, markets] = await Promise.all([
    fetchInChunks<HistoryProfileRaw>(opponentIds, readChunk<HistoryProfileRaw>("user_profiles", "id, username, display_name, is_active")),
    fetchInChunks<HistoryMarketRaw>(marketIds, readChunk<HistoryMarketRaw>("markets", "id, question, fixture_id, market_template, line_value, yes_side, price_outcome_labels")),
  ]);
  const fixtureIds = [...new Set(markets.map((m) => m.fixture_id).filter((id): id is string => Boolean(id)))];
  const [fixtures, postIdByFixtureId] = await Promise.all([
    fetchInChunks<HistoryFixtureRaw>(fixtureIds, readChunk<HistoryFixtureRaw>("fixtures", "id, sport, home_team_name, away_team_name")),
    listPostIdsForFixtures(fixtureIds),
  ]);

  return buildCallBsHistory({ rows, userId, profiles, markets, fixtures, postIdByFixtureId });
}
