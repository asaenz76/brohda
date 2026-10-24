"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { getFreshnessPolicy, classifyFreshness } from "@/lib/prediction-markets/discovery/policy";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { attachConfidenceSchema, commitPredictionSchema, setPickSchema } from "@/lib/validations/predictions";
import { copyForIneligible } from "@/lib/predictions/copy";
import { attachConfidenceStake, createConfidencePrediction, type CommittedPrediction } from "@/lib/confidence/predictions";
import { setPick } from "@/lib/predictions/repository";
import { notifyPickChangedCancellations } from "@/lib/notifications/challenges";
import { createAdminClient } from "@/lib/supabase/admin";
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

  // An open Pick completed with the other side may have cancelled Call BS on it: tell the other participants (best-effort, after the commit).
  if (result.cancelledChallengeIds.length > 0) await notifyPickChangedCancellations(result.cancelledChallengeIds, user.id);

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


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Brohda 2.1 — the two-step composer: (1) a team Pick on its own, (2) optionally, Confidence on that Pick.
// The database decides everything that matters (optional-Confidence switch, deadline with its own clock after its locks, locks, ladder, balance). These actions only check the Market is open to Picks, call
// the database function and translate its plain outcome — and, once an edit has committed, tell the other participant of every Call BS it cancelled.
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface PickActionState {
  success: boolean;
  error: string | null;
  outcome: string | null;
  /** The Market can no longer take a change from this Member (deadline passed, Game started, locked): the composer closes. */
  closed: boolean;
  /** The Member's team Pick after this action (the canonical state), when there is one. */
  selection: "YES" | "NO" | null;
  /** How many Call BS challenges this change cancelled (so the Member is told). */
  cancelledChallenges: number;
}

const pickFail = (error: string, outcome: string, extra: Partial<PickActionState> = {}): PickActionState => ({ success: false, error, outcome, closed: false, selection: null, cancelledChallenges: 0, ...extra });

// M1 observability, on the existing log: one structured line per refused or unusual outcome (T-10 rejections, locked edits, an unbacked Pick refused while optional Picks are off) and per Call BS a Pick change cancelled.
// The database decides every one of these; this only records them (success is not logged — the optional-Picks diagnostics count those from the data). Lock waits and deadlocks surface in the database log.
const NOTEWORTHY = new Set(["past_deadline", "game_started", "pick_locked", "backing_required", "insufficient", "already_backed", "disabled", "error"]);
const record = (action: "set_pick" | "attach_confidence", outcome: string | null, extra: Record<string, unknown> = {}) => {
  if (outcome && (NOTEWORTHY.has(outcome) || Object.keys(extra).length > 0)) console.info(`[picks] ${JSON.stringify({ action, outcome, ...extra })}`);
};

export async function setPickAction(input: { marketId: string; selectedOutcome: "YES" | "NO"; idempotencyKey: string }): Promise<PickActionState> {
  const user = await requireUser();
  const parsed = setPickSchema.safeParse(input);
  if (!parsed.success) return pickFail("Something about that pick wasn't valid.", "invalid");
  const { marketId, selectedOutcome, idempotencyKey } = parsed.data;

  const market = await getMarketById(marketId);
  if (market === null) return pickFail(copyForIneligible("MARKET_NOT_FOUND"), "market_not_found", { closed: true });

  const consumerStatus = deriveConsumerStatus(market.status, market.resolvedOutcome);
  const [freshnessPolicy, predictionPolicy] = await Promise.all([getFreshnessPolicy(), getPredictionPolicy()]);
  const freshness = classifyFreshness(market.lastSyncedAt, market.yesPrice !== null || market.noPrice !== null, freshnessPolicy);
  const eligibility = checkMarketEligibility({ consumerStatus, freshness, yesPrice: market.yesPrice, noPrice: market.noPrice, closesAt: market.closesAt, now: new Date() }, predictionPolicy);
  if (!eligibility.eligible) return pickFail(copyForIneligible(eligibility.reason), "market_ineligible");

  const result = await setPick({
    userId: user.id,
    marketId,
    selectedOutcome,
    // Guaranteed non-null by checkMarketEligibility above.
    yesProbability: market.yesPrice as number,
    noProbability: market.noPrice as number,
    marketQuestionSnapshot: market.question,
    marketCloseAtSnapshot: market.closesAt,
    marketStatusSnapshot: consumerStatus as "ACTIVE" | "CLOSED" | "RESOLVED",
    idempotencyKey,
  }).catch(() => null);
  if (!result) return pickFail("Something went wrong saving your pick. Try again.", "error");

  // After the commit: the other participant of every cancelled Call BS hears about it (never the Member who changed their Pick). Best-effort; a missed one is delivered by the lifecycle job.
  if (result.cancelledChallengeIds.length > 0) await notifyPickChangedCancellations(result.cancelledChallengeIds, user.id);
  record("set_pick", result.outcome === "rejected_cutoff" ? "past_deadline" : result.outcome === "rejected_game_closed" ? "game_started" : result.outcome === "rejected_locked" ? "pick_locked" : result.outcome === "rejected_backing_required" ? "backing_required" : result.outcome, result.cancelledChallengeIds.length > 0 ? { cancelledChallenges: result.cancelledChallengeIds.length } : {});

  switch (result.outcome) {
    case "created":
    case "updated":
    case "unchanged":
    case "replayed":
      revalidatePath(`/markets/${marketId}`);
      return { success: true, error: null, outcome: result.outcome, closed: false, selection: result.prediction?.selectedOutcome ?? selectedOutcome, cancelledChallenges: result.cancelledChallengeIds.length };
    case "rejected_cutoff":
      return pickFail(copyForIneligible("PICK_PAST_CUTOFF"), "past_deadline", { closed: true, selection: result.prediction?.selectedOutcome ?? null });
    case "rejected_game_closed":
      return pickFail(copyForIneligible("GAME_NOT_OPEN"), "game_started", { closed: true });
    case "rejected_locked":
      return pickFail(copyForIneligible("PICK_LOCKED"), "pick_locked", { closed: true, selection: result.prediction?.selectedOutcome ?? null });
    case "rejected_backing_required":
      return pickFail("A pick needs Confidence right now.", "backing_required", { closed: true });
    default:
      return pickFail("That isn't available right now.", result.outcome);
  }
}

export async function attachConfidenceAction(input: { marketId: string; amount: number; idempotencyKey: string }): Promise<CommitPredictionState> {
  const user = await requireUser();
  const parsed = attachConfidenceSchema.safeParse(input);
  if (!parsed.success) return fail("Something about that Confidence wasn't valid.", "invalid");
  const { marketId, amount, idempotencyKey } = parsed.data;

  // The Member's own Pick on this Market, resolved here — never taken from the client.
  const { data: pick } = await createAdminClient().from("predictions").select("id").eq("user_id", user.id).eq("market_id", marketId).maybeSingle();
  if (!pick) return fail("Pick a team first.", "no_pick");

  const result = await attachConfidenceStake({ memberId: user.id, predictionId: pick.id, amount, idempotencyKey }).catch(() => null);
  if (!result) return fail("Something went wrong recording your Confidence. Try again.", "error");
  record("attach_confidence", result.outcome === "past_deadline" || result.outcome === "game_started" || result.outcome === "insufficient" || result.outcome === "already_backed" || result.outcome === "disabled" ? result.outcome : null);

  switch (result.outcome) {
    case "attached":
      revalidatePath(`/markets/${marketId}`);
      revalidatePath("/profile");
      return { success: true, error: null, outcome: "created", closed: false, committed: result.committed };
    case "insufficient":
      return fail(`You only have ${formatConfidence(result.available ?? 0)} available.`, "insufficient", { available: result.available ?? 0 });
    case "invalid_amount":
      return fail("That isn't one of the choices right now.", "invalid_amount");
    case "already_backed":
      return fail("This pick already has Confidence, and it can't be changed.", "already_backed", { closed: true });
    case "past_deadline":
      return fail(copyForIneligible("PICK_PAST_CUTOFF"), "past_deadline", { closed: true });
    case "game_started":
      return fail(copyForIneligible("GAME_NOT_OPEN"), "game_started", { closed: true });
    case "pick_graded":
      return fail(copyForIneligible("PICK_LOCKED"), "pick_locked", { closed: true });
    case "disabled":
    case "retired":
      return fail("Predictions are paused right now.", "disabled", { closed: true });
    default:
      return fail("That isn't available right now.", result.outcome);
  }
}
