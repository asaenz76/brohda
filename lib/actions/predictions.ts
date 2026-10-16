"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { getFreshnessPolicy, classifyFreshness } from "@/lib/prediction-markets/discovery/policy";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { commitPredictionSchema } from "@/lib/validations/predictions";
import { copyForIneligible } from "@/lib/predictions/copy";
import { createConfidencePrediction, type CommittedPrediction } from "@/lib/confidence/predictions";
import { formatConfidence } from "@/lib/confidence/format";

// A prediction is a side AND the Confidence behind it. Tapping a side is local composer state and never reaches the server; tapping a Confidence level is the commitment, and this is the one action it calls.
// Market-level eligibility (status / price / freshness) is checked here, reusing checkMarketEligibility unchanged; everything else — the capability, the Member, the Game and the T-minus deadline, the configured ladder,
// the available Confidence, the Pick, its stake, the reserve and the lock — is decided atomically inside the database function, so a refused attempt creates nothing at all. The idempotency key makes a double tap or a
// retry return the original result instead of a second prediction. There is deliberately no action that saves a Pick without Confidence.

export interface CommitPredictionState {
  success: boolean;
  /** Plain words for the Member; null on success. */
  error: string | null;
  /** The database's outcome code, for the composer to decide what to show (e.g. close itself when the deadline has passed). */
  outcome: string | null;
  /** True when this Market can no longer take a prediction from this Member (deadline passed, Game started, already predicted/locked): the composer closes. */
  closed: boolean;
  /** The committed prediction (the canonical state), on success and when the Member had already predicted this Market. */
  committed: CommittedPrediction | null;
  /** The Member's current available Confidence when the answer was "not enough". */
  available?: number;
}

const fail = (error: string, outcome: string, extra: Partial<CommitPredictionState> = {}): CommitPredictionState => ({ success: false, error, outcome, closed: false, committed: null, ...extra });

export async function commitPredictionAction(input: { marketId: string; selectedOutcome: "YES" | "NO"; amount: number; idempotencyKey: string }): Promise<CommitPredictionState> {
  const user = await requireUser();

  const parsed = commitPredictionSchema.safeParse(input);
  if (!parsed.success) return fail("Something about that prediction wasn't valid.", "invalid");
  const { marketId, selectedOutcome, amount, idempotencyKey } = parsed.data;

  const market = await getMarketById(marketId);
  if (market === null) return fail(copyForIneligible("MARKET_NOT_FOUND"), "market_not_found", { closed: true });

  const consumerStatus = deriveConsumerStatus(market.status, market.resolvedOutcome);
  const [freshnessPolicy, predictionPolicy] = await Promise.all([getFreshnessPolicy(), getPredictionPolicy()]);
  const freshness = classifyFreshness(market.lastSyncedAt, market.yesPrice !== null || market.noPrice !== null, freshnessPolicy);

  const eligibility = checkMarketEligibility(
    { consumerStatus, freshness, yesPrice: market.yesPrice, noPrice: market.noPrice, closesAt: market.closesAt, now: new Date() },
    predictionPolicy,
  );
  if (!eligibility.eligible) return fail(copyForIneligible(eligibility.reason), "market_ineligible");

  // Guaranteed non-null by checkMarketEligibility's own PRICE_UNAVAILABLE check above. Read fresh on every call: the snapshot reflects THIS prediction's own context.
  const result = await createConfidencePrediction({
    memberId: user.id,
    marketId,
    selectedOutcome,
    amount,
    yesProbability: market.yesPrice as number,
    noProbability: market.noPrice as number,
    marketQuestionSnapshot: market.question,
    marketCloseAtSnapshot: market.closesAt,
    // Non-null by the same eligibility check (MARKET_INACTIVE covers null).
    marketStatusSnapshot: consumerStatus as string,
    idempotencyKey,
  }).catch(() => null);
  if (!result) return fail("Something went wrong recording your prediction. Try again.", "error");

  // The balance in the shell, the card and the profile change with a prediction: refresh the signed-in layout.
  if (result.outcome === "created" || result.outcome === "already_predicted") {
    revalidatePath(`/markets/${marketId}`);
    revalidatePath("/profile");
  }

  switch (result.outcome) {
    case "created":
    case "already_predicted":
      return { success: true, error: null, outcome: result.outcome, closed: result.outcome === "already_predicted", committed: result.committed };
    case "insufficient":
      return fail(`You only have ${formatConfidence(result.available ?? 0)} available.`, "insufficient", { available: result.available ?? 0 });
    case "invalid_amount":
      return fail("That isn't one of the choices right now.", "invalid_amount");
    case "past_deadline":
      return fail(copyForIneligible("PICK_PAST_CUTOFF"), "past_deadline", { closed: true });
    case "game_started":
      return fail(copyForIneligible("GAME_NOT_OPEN"), "game_started", { closed: true });
    case "pick_locked":
      return fail(copyForIneligible("PICK_LOCKED"), "pick_locked", { closed: true });
    case "disabled":
      return fail("Predictions are paused right now.", "disabled", { closed: true });
    default:
      return fail("That isn't available right now.", result.outcome);
  }
}
