"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { getFreshnessPolicy, classifyFreshness } from "@/lib/prediction-markets/discovery/policy";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { setPick } from "@/lib/predictions/repository";
import { submitPredictionSchema } from "@/lib/validations/predictions";
import { copyForIneligible } from "@/lib/predictions/copy";
import type { PredictionMarketStatusSnapshot } from "@/lib/predictions/types";

// Milestone R5 (docs/BROHDA_2_0_MILESTONE_MAP.md, Pick Editing + Locking):
// Brohda's single coherent create-or-edit Pick operation (§25) — the same
// action whether this is the user's first Pick on this Market or a change
// to an existing one; the server (ultimately the `set_pick` SQL function)
// decides which. Market-level eligibility (status/price/freshness) is
// still checked here in TypeScript, reusing checkMarketEligibility
// unchanged; Game-level eligibility (kickoff cutoff, Game status, existing
// lock state) is decided authoritatively inside set_pick() itself, live,
// inside the same locked transaction as the write (§11, §28-29) — this
// action never pre-decides that part.
//
// The old prediction_allow_repeat policy (checked here pre-R5 to reject a
// second submission as ALREADY_PREDICTED) is no longer consulted: its old
// meaning — "may a user submit more than once" — is fully superseded by
// Pick editing, and the new (user_id, market_id) uniqueness constraint
// makes a genuine duplicate row structurally impossible regardless. The
// column itself was left in place (removing configuration is out of this
// milestone's scope), but no code path reads it anymore.

export interface SubmitPredictionState {
  success: boolean;
  error: string | null;
  /** True when the request was rejected specifically because the Pick is locked (cutoff passed, Game no longer open, or already permanently locked) — lets the UI show "locked" copy/state rather than a generic retryable error. */
  locked: boolean;
  confirmation: { selectedOutcome: "YES" | "NO"; probabilityPercent: number } | null;
}

export async function submitPredictionAction(input: {
  marketId: string;
  selectedOutcome: "YES" | "NO";
  idempotencyKey: string;
}): Promise<SubmitPredictionState> {
  const user = await requireUser();

  const parsed = submitPredictionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Something about that prediction wasn't valid.", locked: false, confirmation: null };
  }
  const { marketId, selectedOutcome, idempotencyKey } = parsed.data;

  const market = await getMarketById(marketId);
  if (market === null) {
    return { success: false, error: copyForIneligible("MARKET_NOT_FOUND"), locked: false, confirmation: null };
  }

  const consumerStatus = deriveConsumerStatus(market.status, market.resolvedOutcome);
  const freshnessPolicy = await getFreshnessPolicy();
  const freshness = classifyFreshness(market.lastSyncedAt, market.yesPrice !== null || market.noPrice !== null, freshnessPolicy);
  const predictionPolicy = await getPredictionPolicy();

  const eligibility = checkMarketEligibility(
    {
      consumerStatus,
      freshness,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      closesAt: market.closesAt,
      now: new Date(),
    },
    predictionPolicy,
  );
  if (!eligibility.eligible) {
    return { success: false, error: copyForIneligible(eligibility.reason), locked: false, confirmation: null };
  }

  // Guaranteed non-null by checkMarketEligibility's own PRICE_UNAVAILABLE
  // check above — this `as number` documents that guarantee rather than
  // re-deriving it. Never fabricated, never derived from the other side.
  // Read fresh on every call (create or edit) — this is exactly what
  // makes the final selection's probability snapshot reflect its OWN
  // Pick-time context (§9), not stale context from an earlier selection.
  const yesProbability = market.yesPrice as number;
  const noProbability = market.noPrice as number;
  // Non-null by the same eligibility check (MARKET_INACTIVE covers null).
  const marketStatusSnapshot = consumerStatus as PredictionMarketStatusSnapshot;

  const { prediction, outcome } = await setPick({
    userId: user.id,
    marketId,
    selectedOutcome,
    yesProbability,
    noProbability,
    marketQuestionSnapshot: market.question,
    marketCloseAtSnapshot: market.closesAt,
    marketStatusSnapshot,
    idempotencyKey,
  });

  if (outcome === "rejected_cutoff") {
    return { success: false, error: copyForIneligible("PICK_PAST_CUTOFF"), locked: true, confirmation: null };
  }
  if (outcome === "rejected_game_closed") {
    return { success: false, error: copyForIneligible("GAME_NOT_OPEN"), locked: true, confirmation: null };
  }
  if (outcome === "rejected_locked") {
    return { success: false, error: copyForIneligible("PICK_LOCKED"), locked: true, confirmation: null };
  }
  // set_pick never returns a null prediction for created/updated/unchanged/replayed.
  if (prediction === null) {
    return { success: false, error: "Something went wrong recording your prediction.", locked: false, confirmation: null };
  }

  revalidatePath(`/markets/${marketId}`);
  revalidatePath("/profile");

  const probability = prediction.selectedOutcome === "YES" ? prediction.yesProbabilitySnapshot : prediction.noProbabilitySnapshot;
  return {
    success: true,
    error: null,
    locked: false,
    confirmation: { selectedOutcome: prediction.selectedOutcome, probabilityPercent: Math.round(probability * 100) },
  };
}
