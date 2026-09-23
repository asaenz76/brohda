import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Challenge, ChallengeRecord, ChallengeResult, ChallengeStatus } from "./types";
import type { PredictionOutcome } from "@/lib/predictions/types";

// Milestone R7 — the sole query/mutation surface for `challenges`, matching
// this codebase's established one-repository-per-table convention.
// Mutations go through call_bs()/accept_call_bs()/decline_call_bs() (SQL
// functions, service-role only) — never a plain insert/update here, except
// the resolution job's own guarded update (see lib/challenges/resolution.ts),
// which mirrors lib/predictions/repository.ts's markPredictionGraded()
// exactly (a plain, idempotency-guarded admin update, not an RPC — the
// same precedent for a trusted, server-only batch operation).

interface ChallengeRow {
  id: string;
  market_id: string;
  challenger_user_id: string;
  recipient_user_id: string;
  challenger_prediction_id: string;
  recipient_prediction_id: string;
  challenger_selection_snapshot: PredictionOutcome;
  recipient_selection_snapshot: PredictionOutcome;
  status: ChallengeStatus;
  result: ChallengeResult | null;
  accepted_at: string | null;
  declined_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: ChallengeRow): Challenge {
  return {
    id: row.id,
    marketId: row.market_id,
    challengerUserId: row.challenger_user_id,
    recipientUserId: row.recipient_user_id,
    challengerPredictionId: row.challenger_prediction_id,
    recipientPredictionId: row.recipient_prediction_id,
    challengerSelectionSnapshot: row.challenger_selection_snapshot,
    recipientSelectionSnapshot: row.recipient_selection_snapshot,
    status: row.status,
    result: row.result,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CallBsOutcome =
  | { ok: true; challenge: Challenge }
  | { ok: false; error: string };

/**
 * Wraps call_bs() (§9-13). The only client-meaningful input is the
 * recipient's Pick id — everything else the RPC itself derives
 * server-side. Rejections surface as plain exceptions from the SQL
 * function (no partial state to preserve on that path — see the
 * migration's own header comment) — normalized here into a typed result
 * so the Server Action never has to parse a raw Postgres error message
 * more than once.
 */
export async function callBS(challengerUserId: string, recipientPredictionId: string): Promise<CallBsOutcome> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("call_bs", { p_challenger_user_id: challengerUserId, p_recipient_prediction_id: recipientPredictionId })
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, challenge: toDomain(data as ChallengeRow) };
}

export type AcceptCallBsOutcome = "accepted" | "not_pending" | "rejected_cutoff" | "rejected_invalidated";

export interface AcceptCallBsResult {
  challenge: Challenge;
  outcome: AcceptCallBsOutcome;
}

interface AcceptCallBsRpcRow {
  challenge: ChallengeRow;
  outcome: AcceptCallBsOutcome;
}

/** Wraps accept_call_bs() — the atomic acceptance transaction (§19-23). Throws only for a genuine security violation (`not_recipient`) or a missing row (`challenge_not_found`); every ordinary business outcome comes back through the typed `outcome` field instead. */
export async function acceptCallBS(challengeId: string, recipientUserId: string): Promise<AcceptCallBsResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("accept_call_bs", { p_challenge_id: challengeId, p_recipient_user_id: recipientUserId })
    .single();
  if (error) throw error;
  const row = data as AcceptCallBsRpcRow;
  return { challenge: toDomain(row.challenge), outcome: row.outcome };
}

/** Wraps decline_call_bs() (§27) — plain PENDING -> DECLINED, no Pick side effect. Throws for every rejection (`not_recipient`, `not_pending`, `challenge_not_found`) — a decline has no "materialize then reject" hazard, so a plain exception is the correct, simpler shape here. */
export async function declineCallBS(challengeId: string, recipientUserId: string): Promise<Challenge> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("decline_call_bs", { p_challenge_id: challengeId, p_recipient_user_id: recipientUserId })
    .single();
  if (error) throw error;
  return toDomain(data as ChallengeRow);
}

export async function getChallengeById(id: string): Promise<Challenge | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("challenges").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as ChallengeRow) : null;
}

/** Challenges awaiting this user's own decision (§46). */
export async function listIncomingPendingChallenges(userId: string): Promise<Challenge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenges")
    .select("*")
    .eq("recipient_user_id", userId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ChallengeRow[]).map(toDomain);
}

/** Challenges this user sent, still awaiting the recipient (§46). */
export async function listOutgoingPendingChallenges(userId: string): Promise<Challenge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenges")
    .select("*")
    .eq("challenger_user_id", userId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ChallengeRow[]).map(toDomain);
}

/** This user's currently-accepted (not yet resolved) Challenges (§46). */
export async function listActiveChallenges(userId: string): Promise<Challenge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenges")
    .select("*")
    .or(`challenger_user_id.eq.${userId},recipient_user_id.eq.${userId}`)
    .eq("status", "ACCEPTED")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ChallengeRow[]).map(toDomain);
}

/** This user's resolved Challenge history, most recent first (§46, §48) — a defensive cap, not real pagination, matching listUserPredictions' own existing precedent. */
export async function listResolvedChallenges(userId: string, limit = 50): Promise<Challenge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenges")
    .select("*")
    .or(`challenger_user_id.eq.${userId},recipient_user_id.eq.${userId}`)
    .eq("status", "RESOLVED")
    .order("resolved_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ChallengeRow[]).map(toDomain);
}

/** Every currently-visible Challenge (any status) between this user and a specific Market's participants — used to compute per-participant `canCallBs` (§42) without a second round-trip per participant. */
export async function listChallengesForMarketAndUser(marketId: string, userId: string): Promise<Challenge[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenges")
    .select("*")
    .eq("market_id", marketId)
    .or(`challenger_user_id.eq.${userId},recipient_user_id.eq.${userId}`);
  if (error) throw error;
  return (data as ChallengeRow[]).map(toDomain);
}

/**
 * The purely factual head-to-head tally (§38-39, §48) — no scoring, no
 * weighting, a plain count. R11 owns any future reputation derivation;
 * this is the raw material it will consume.
 */
export async function getChallengeRecordForUser(userId: string): Promise<ChallengeRecord> {
  const admin = createAdminClient();
  const [{ count: wins, error: winsError }, { count: losses, error: lossesError }, { count: voids, error: voidsError }] = await Promise.all([
    admin
      .from("challenges")
      .select("id", { count: "exact", head: true })
      .eq("status", "RESOLVED")
      .or(`and(challenger_user_id.eq.${userId},result.eq.CHALLENGER_WON),and(recipient_user_id.eq.${userId},result.eq.RECIPIENT_WON)`),
    admin
      .from("challenges")
      .select("id", { count: "exact", head: true })
      .eq("status", "RESOLVED")
      .or(`and(challenger_user_id.eq.${userId},result.eq.RECIPIENT_WON),and(recipient_user_id.eq.${userId},result.eq.CHALLENGER_WON)`),
    admin
      .from("challenges")
      .select("id", { count: "exact", head: true })
      .eq("status", "RESOLVED")
      .or(`challenger_user_id.eq.${userId},recipient_user_id.eq.${userId}`)
      .eq("result", "VOID"),
  ]);
  if (winsError) throw winsError;
  if (lossesError) throw lossesError;
  if (voidsError) throw voidsError;
  return { wins: wins ?? 0, losses: losses ?? 0, voids: voids ?? 0 };
}

/**
 * Every ACCEPTED Challenge not yet RESOLVED — the resolution job's own
 * work queue (mirrors lib/predictions/repository.ts's
 * listPendingPredictions exactly). Bounded, so one run never processes an
 * unbounded backlog.
 *
 * Milestone R13.5: `platform_settings.challenge_resolution_batch_size`
 * (default 200, matching this function's own former hard-coded default
 * exactly) is the canonical source, live-read on every call, changeable
 * by an operator with no deployment — same pattern R12 already
 * established for `listSettlementEligiblePositionIds()`. An explicit
 * `limit` argument still overrides it (used by tests that need a
 * smaller, deterministic batch).
 */
export async function listUnresolvedAcceptedChallenges(limit?: number): Promise<Challenge[]> {
  const admin = createAdminClient();
  let effectiveLimit: number = limit ?? 200;
  if (limit === undefined) {
    const { data: settingsRow } = await admin.from("platform_settings").select("challenge_resolution_batch_size").eq("id", true).single();
    effectiveLimit = settingsRow?.challenge_resolution_batch_size ?? 200;
  }
  const { data, error } = await admin
    .from("challenges")
    .select("*")
    .eq("status", "ACCEPTED")
    .order("accepted_at", { ascending: true })
    .limit(effectiveLimit);
  if (error) throw error;
  return (data as ChallengeRow[]).map(toDomain);
}

/**
 * The only mutation the resolution job ever performs — one-way, ACCEPTED
 * to RESOLVED. Guarded by `.eq("status", "ACCEPTED")` in the update itself
 * (not just the caller's query), so a concurrent/duplicate resolution pass
 * over the same row is a safe no-op (`data` comes back empty) rather than
 * a second write — the exact idempotency shape markPredictionGraded()
 * already established.
 */
export async function markChallengeResolved(id: string, outcome: { result: ChallengeResult; resolvedAt: string }): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenges")
    .update({ status: "RESOLVED", result: outcome.result, resolved_at: outcome.resolvedAt, updated_at: outcome.resolvedAt })
    .eq("id", id)
    .eq("status", "ACCEPTED")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
