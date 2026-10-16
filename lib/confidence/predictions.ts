import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// The one way a prediction is created: a side AND the Confidence behind it, in one database transaction (create_confidence_prediction). Nothing in the application can persist a Pick without a stake: the generic Pick function is not
// exposed to Members and, once the cutover is set, refuses to run outside this function. The database decides everything (capability, Member, deadline and Game state, the configured ladder, available balance, the
// Pick, its stake, the reserve and the lock) and returns a plain outcome; a refused attempt writes nothing.

export type CreatePredictionOutcome =
  | "created"
  | "already_predicted"
  | "disabled"
  | "ineligible"
  | "invalid_amount"
  | "game_started"
  | "past_deadline"
  | "pick_locked"
  | "insufficient"
  | "idempotency_conflict"
  | "rejected";

export interface CommittedPrediction {
  predictionId: string;
  selectedOutcome: "YES" | "NO";
  amount: number;
  available?: number;
  reserved?: number;
  total?: number;
}

export interface CreatePredictionResult {
  outcome: CreatePredictionOutcome;
  committed: CommittedPrediction | null;
  /** The Member's available Confidence when that was the reason (insufficient). */
  available?: number;
  replay?: boolean;
}

export interface CreatePredictionInput {
  memberId: string;
  marketId: string;
  selectedOutcome: "YES" | "NO";
  amount: number;
  yesProbability: number;
  noProbability: number;
  marketQuestionSnapshot: string;
  marketCloseAtSnapshot: string | null;
  marketStatusSnapshot: string;
  idempotencyKey: string;
}

interface Row {
  outcome: CreatePredictionOutcome;
  predictionId?: string;
  selectedOutcome?: "YES" | "NO";
  amount?: number;
  available?: number;
  reserved?: number;
  total?: number;
  replay?: boolean;
}

export async function createConfidencePrediction(input: CreatePredictionInput): Promise<CreatePredictionResult> {
  const { data, error } = await createAdminClient().rpc("create_confidence_prediction", {
    p_user_id: input.memberId,
    p_market_id: input.marketId,
    p_selected_outcome: input.selectedOutcome,
    p_amount: input.amount,
    p_yes_probability: input.yesProbability,
    p_no_probability: input.noProbability,
    p_market_question: input.marketQuestionSnapshot,
    p_market_close_at: input.marketCloseAtSnapshot,
    p_market_status: input.marketStatusSnapshot,
    p_idempotency_key: input.idempotencyKey,
  });
  // PostgREST errors are plain objects: wrap so the caller sees a real Error.
  if (error) throw new Error(error.message);
  const row = data as Row;
  const committed: CommittedPrediction | null =
    (row.outcome === "created" || row.outcome === "already_predicted") && row.predictionId && row.selectedOutcome && typeof row.amount === "number"
      ? { predictionId: row.predictionId, selectedOutcome: row.selectedOutcome, amount: row.amount, available: row.available, reserved: row.reserved, total: row.total }
      : null;
  return { outcome: row.outcome, committed, available: row.available, replay: row.replay };
}
