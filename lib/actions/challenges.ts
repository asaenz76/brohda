"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { callBS, acceptCallBS, declineCallBS } from "@/lib/challenges/repository";
import { callBsSchema, respondToChallengeSchema } from "@/lib/validations/challenges";
import { checkCallBsRateLimit } from "@/lib/rate-limit/challenges";
import {
  createChallengeReceivedNotification,
  createChallengeAcceptedNotification,
  createChallengeDeclinedNotification,
} from "@/lib/notifications/challenges";
import type { Challenge } from "@/lib/challenges/types";

// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges).
// Mirrors lib/actions/post-comments.ts's/lib/actions/predictions.ts's own
// shape: authenticated + validated + rate-limited + server-derived
// identity, every write through a SECURITY DEFINER RPC via the service
// role, never trusting a client-supplied challenger/recipient/Market/Pick
// id where the server can derive it instead (§9, §52).

export type CallBsActionResult = { error: string | null; challenge: Challenge | null };

const CALL_BS_ERROR_COPY: Record<string, string> = {
  call_bs_disabled: "Call BS isn't available right now.",
  recipient_pick_not_found: "That pick couldn't be found.",
  challenger_pick_not_found: "Make your own pick on this market before calling BS.",
  self_challenge: "You can't call BS on your own pick.",
  picks_not_opposing: "You can only call BS on someone with the opposite pick.",
  pick_already_graded: "This market has already been graded.",
  market_not_found: "That market couldn't be found.",
  past_challenge_cutoff: "It's too close to kickoff to call BS.",
  duplicate_pending_challenge: "You already have a pending Call BS with this pick.",
};

function copyForCallBsError(message: string): string {
  return CALL_BS_ERROR_COPY[message] ?? "Could not send Call BS.";
}

export async function callBSAction(recipientPredictionId: string, marketId: string): Promise<CallBsActionResult> {
  const user = await requireUser();

  const parsed = callBsSchema.safeParse({ recipientPredictionId });
  if (!parsed.success) {
    return { error: "Invalid pick.", challenge: null };
  }

  const allowed = await checkCallBsRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many Call BS attempts. Try again in a moment.", challenge: null };
  }

  const outcome = await callBS(user.id, parsed.data.recipientPredictionId);
  if (!outcome.ok) {
    return { error: copyForCallBsError(outcome.error), challenge: null };
  }

  await createChallengeReceivedNotification(outcome.challenge);

  revalidatePath(`/markets/${marketId}`);
  return { error: null, challenge: outcome.challenge };
}

export type RespondToChallengeActionResult = { error: string | null; challenge: Challenge | null };

const RESPOND_ERROR_COPY: Record<string, string> = {
  challenge_not_found: "That Call BS couldn't be found.",
  not_recipient: "This Call BS isn't addressed to you.",
  not_pending: "This Call BS has already been resolved.",
};

export async function acceptChallengeAction(challengeId: string, marketId: string): Promise<RespondToChallengeActionResult> {
  const user = await requireUser();

  const parsed = respondToChallengeSchema.safeParse({ challengeId });
  if (!parsed.success) {
    return { error: "Invalid Call BS.", challenge: null };
  }

  let result;
  try {
    result = await acceptCallBS(parsed.data.challengeId, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: RESPOND_ERROR_COPY[message] ?? "Could not accept this Call BS.", challenge: null };
  }

  if (result.outcome === "not_pending") {
    return { error: "This Call BS is no longer pending.", challenge: result.challenge };
  }
  if (result.outcome === "rejected_cutoff") {
    return { error: "It's too close to kickoff to accept this Call BS.", challenge: result.challenge };
  }
  if (result.outcome === "rejected_invalidated") {
    return { error: "One of the picks changed since this Call BS was sent, so it can no longer be accepted.", challenge: result.challenge };
  }

  await createChallengeAcceptedNotification(result.challenge);

  revalidatePath(`/markets/${marketId}`);
  return { error: null, challenge: result.challenge };
}

export async function declineChallengeAction(challengeId: string, marketId: string): Promise<RespondToChallengeActionResult> {
  const user = await requireUser();

  const parsed = respondToChallengeSchema.safeParse({ challengeId });
  if (!parsed.success) {
    return { error: "Invalid Call BS.", challenge: null };
  }

  let challenge: Challenge;
  try {
    challenge = await declineCallBS(parsed.data.challengeId, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: RESPOND_ERROR_COPY[message] ?? "Could not decline this Call BS.", challenge: null };
  }

  await createChallengeDeclinedNotification(challenge);

  revalidatePath(`/markets/${marketId}`);
  return { error: null, challenge };
}
