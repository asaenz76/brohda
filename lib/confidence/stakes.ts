import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfidenceConfig } from "./config";

// Confidence put behind a Pick. Reads only: the attach and the settlement are database functions (service role, atomic), called from the server action and the grading transaction. Nothing here imports wallet,
// monetary or payment code, and nothing here computes a sports result — settlement uses the existing canonical grade.

export type StakeUiState =
  | { state: "none" }
  | { state: "unavailable"; reason: "disabled" | "ineligible" }
  | { state: "closed"; reason: "graded" | "market" | "game_started" | "deadline" }
  | { state: "open"; available: number; allowedStakes: number[]; locksAt: string }
  | { state: "staked"; amount: number; stakeState: "RESERVED" | "SETTLED_CORRECT" | "SETTLED_INCORRECT" | "SETTLED_VOID"; result: "CORRECT" | "INCORRECT" | "VOID" | null };

/**
 * What the Pick card shows about Confidence for the signed-in Member's OWN Pick, decided by the same database checks the attach itself makes (so the button and the answer can never disagree). Returns `none`
 * while Confidence is off or for anything that is not the caller's Pick. An existing commitment is always shown, whatever the capability says.
 */
export async function getStakeUiState(memberId: string, predictionId: string): Promise<StakeUiState> {
  const admin = createAdminClient();
  // Existing commitments are shown even if the capability was later switched off (they still settle).
  const { data, error } = await admin.rpc("confidence_stake_status", { p_member_id: memberId, p_prediction_id: predictionId });
  if (error || !data) return { state: "none" };
  const row = data as Record<string, unknown>;
  if (row.state === "staked") return { state: "staked", amount: Number(row.amount), stakeState: row.stakeState as never, result: (row.result as never) ?? null };
  // Without Confidence on, nothing new is offered or shown.
  if (!(await getConfidenceConfig())) return { state: "none" };
  if (row.state === "open") return { state: "open", available: Number(row.available), allowedStakes: (row.allowedStakes as number[]) ?? [], locksAt: String(row.locksAt) };
  if (row.state === "closed") return { state: "closed", reason: row.reason as never };
  if (row.state === "unavailable") return { state: "unavailable", reason: row.reason as never };
  return { state: "none" };
}

export interface PublicStake {
  predictionId: string;
  amount: number;
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
  state: string;
}

/**
 * The committed amount on a set of Picks, keyed by Pick id, for showing conviction beside a Pick that is ALREADY visible to the viewer (the viewer's own Picks, or someone's graded Picks on their public
 * profile). It is never an account-wide figure and never includes a Pick the viewer cannot already see.
 */
export async function getStakesForPredictions(predictionIds: string[]): Promise<Map<string, PublicStake>> {
  const map = new Map<string, PublicStake>();
  if (predictionIds.length === 0) return map;
  const { data } = await createAdminClient().from("confidence_prediction_stakes").select("prediction_id, amount, state, result").in("prediction_id", predictionIds);
  for (const s of data ?? []) map.set(s.prediction_id, { predictionId: s.prediction_id, amount: Number(s.amount), state: s.state, result: s.result });
  return map;
}
