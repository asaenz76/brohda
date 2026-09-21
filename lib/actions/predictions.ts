"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { getFreshnessPolicy, classifyFreshness } from "@/lib/prediction-markets/discovery/policy";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { createPrediction, getLatestUserPredictionForMarket } from "@/lib/predictions/repository";
import { submitPredictionSchema } from "@/lib/validations/predictions";
import { copyForIneligible } from "@/lib/predictions/copy";
import type { PredictionMarketStatusSnapshot } from "@/lib/predictions/types";

// Milestone 3's only Prediction mutation (roadmap STEP 3, STEP 11).
// Deliberately not financial machinery: authenticated + validated +
// policy-checked + idempotent, but no wallet, no RPC transaction, no
// SECURITY DEFINER function — a plain service-role insert is sufficient
// (see lib/predictions/repository.ts's own reasoning).

export interface SubmitPredictionState {
  success: boolean;
  error: string | null;
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
    return { success: false, error: "Something about that prediction wasn't valid.", confirmation: null };
  }
  const { marketId, selectedOutcome, idempotencyKey } = parsed.data;

  const market = await getMarketById(marketId);
  if (market === null) {
    return { success: false, error: copyForIneligible("MARKET_NOT_FOUND"), confirmation: null };
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
    return { success: false, error: copyForIneligible(eligibility.reason), confirmation: null };
  }

  if (!predictionPolicy.allowRepeat) {
    const existing = await getLatestUserPredictionForMarket(user.id, marketId);
    if (existing !== null) {
      return { success: false, error: copyForIneligible("ALREADY_PREDICTED"), confirmation: null };
    }
  }

  // Guaranteed non-null by checkMarketEligibility's own PRICE_UNAVAILABLE
  // check above — this `as number` documents that guarantee rather than
  // re-deriving it. Never fabricated, never derived from the other side.
  const yesProbabilitySnapshot = market.yesPrice as number;
  const noProbabilitySnapshot = market.noPrice as number;
  // Non-null by the same eligibility check (MARKET_INACTIVE covers null).
  const marketStatusSnapshot = consumerStatus as PredictionMarketStatusSnapshot;

  const { prediction } = await createPrediction({
    userId: user.id,
    marketId,
    selectedOutcome,
    yesProbabilitySnapshot,
    noProbabilitySnapshot,
    marketQuestionSnapshot: market.question,
    marketCloseAtSnapshot: market.closesAt,
    marketStatusSnapshot,
    idempotencyKey,
  });

  revalidatePath(`/markets/${marketId}`);
  revalidatePath("/profile");

  const probability = prediction.selectedOutcome === "YES" ? prediction.yesProbabilitySnapshot : prediction.noProbabilitySnapshot;
  return {
    success: true,
    error: null,
    confirmation: { selectedOutcome: prediction.selectedOutcome, probabilityPercent: Math.round(probability * 100) },
  };
}
