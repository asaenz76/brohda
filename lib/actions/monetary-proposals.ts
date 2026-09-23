"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { proposeMoney, acceptMonetaryProposal, declineMonetaryProposal, withdrawMonetaryProposal } from "@/lib/monetary/repository";
import { proposeMoneySchema, respondToMonetaryProposalSchema } from "@/lib/validations/monetary-proposals";
import { checkMonetaryProposalRateLimit } from "@/lib/rate-limit/monetary-proposals";
import {
  createMonetaryProposalReceivedNotification,
  createMonetaryProposalAcceptedNotification,
  createMonetaryProposalDeclinedNotification,
  createMonetaryProposalWithdrawnNotification,
} from "@/lib/notifications/monetary-proposals";
import type { MonetaryProposal, MonetaryPosition } from "@/lib/monetary/types";

// Milestone R9. Mirrors lib/actions/challenges.ts's own shape exactly:
// authenticated + validated + rate-limited + server-derived identity,
// every write through a SECURITY DEFINER RPC via the service role, never
// trusting a client-supplied proposer/recipient/Market/Pick id where the
// server can derive it instead (§63-64). The idempotency key is generated
// here (crypto.randomUUID()) rather than accepted from the client — a
// double-submit retry with a fresh key is treated as a new attempt, which
// is safe because a real duplicate is still caught by
// monetary_proposals_one_pending_pair inside propose_money() itself.

export type ProposeMoneyActionResult = { error: string | null; proposal: MonetaryProposal | null };

const PROPOSE_MONEY_ERROR_COPY: Record<string, string> = {
  monetary_p2p_disabled: "Putting money on picks isn't available right now.",
  recipient_pick_not_found: "That pick couldn't be found.",
  proposer_pick_not_found: "Make your own pick on this market before proposing money.",
  self_proposal: "You can't propose money on your own pick.",
  picks_not_opposing: "You can only propose money against someone with the opposite pick.",
  pick_already_graded: "This market has already been graded.",
  market_not_found: "That market couldn't be found.",
  past_monetary_cutoff: "It's too close to kickoff to propose money.",
  source_challenge_not_found: "That Call BS couldn't be found.",
  source_challenge_not_accepted: "That Call BS hasn't been accepted yet.",
  source_challenge_market_mismatch: "That Call BS doesn't belong to this market.",
  source_challenge_participant_mismatch: "That Call BS doesn't involve both of you.",
  source_challenge_pick_mismatch: "That Call BS doesn't match these picks.",
  duplicate_pending_proposal: "You already have a pending proposal with this pick.",
  insufficient_available_balance: "You don't have enough available balance to cover this stake.",
};

function copyForProposeMoneyError(message: string): string {
  return PROPOSE_MONEY_ERROR_COPY[message] ?? "Could not send this proposal.";
}

export async function proposeMoneyAction(
  recipientPredictionId: string,
  stake: number,
  marketId: string,
  sourceChallengeId: string | null = null,
): Promise<ProposeMoneyActionResult> {
  const user = await requireUser();

  const parsed = proposeMoneySchema.safeParse({ recipientPredictionId, stake, sourceChallengeId });
  if (!parsed.success) {
    return { error: "Invalid proposal.", proposal: null };
  }

  const allowed = await checkMonetaryProposalRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many proposals. Try again in a moment.", proposal: null };
  }

  const idempotencyKey = crypto.randomUUID();
  const outcome = await proposeMoney(user.id, parsed.data.recipientPredictionId, parsed.data.stake, idempotencyKey, parsed.data.sourceChallengeId ?? null);
  if (!outcome.ok) {
    return { error: copyForProposeMoneyError(outcome.error), proposal: null };
  }

  await createMonetaryProposalReceivedNotification(outcome.proposal);

  revalidatePath(`/markets/${marketId}`);
  return { error: null, proposal: outcome.proposal };
}

export type RespondToMonetaryProposalActionResult = { error: string | null; proposal: MonetaryProposal | null; position: MonetaryPosition | null };

const RESPOND_ERROR_COPY: Record<string, string> = {
  proposal_not_found: "That proposal couldn't be found.",
  not_recipient: "This proposal isn't addressed to you.",
  not_proposer: "This proposal isn't yours to withdraw.",
  not_pending: "This proposal has already been resolved.",
  monetary_p2p_disabled: "Putting money on picks isn't available right now.",
};

export async function acceptMonetaryProposalAction(proposalId: string, marketId: string): Promise<RespondToMonetaryProposalActionResult> {
  const user = await requireUser();

  const parsed = respondToMonetaryProposalSchema.safeParse({ proposalId });
  if (!parsed.success) {
    return { error: "Invalid proposal.", proposal: null, position: null };
  }

  let result;
  try {
    result = await acceptMonetaryProposal(parsed.data.proposalId, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: RESPOND_ERROR_COPY[message] ?? "Could not accept this proposal.", proposal: null, position: null };
  }

  if (result.outcome === "not_pending") {
    return { error: "This proposal is no longer pending.", proposal: result.proposal, position: null };
  }
  if (result.outcome === "rejected_cutoff") {
    return { error: "It's too close to kickoff to accept this proposal.", proposal: result.proposal, position: null };
  }
  if (result.outcome === "rejected_invalidated") {
    return { error: "One of the picks changed since this proposal was sent, so it can no longer be accepted.", proposal: result.proposal, position: null };
  }
  if (result.outcome === "proposer_reservation_invalid") {
    return { error: "This proposal can't be accepted right now. Please try again later.", proposal: result.proposal, position: null };
  }
  if (result.outcome === "insufficient_recipient_balance") {
    return { error: "You don't have enough available balance to cover this stake.", proposal: result.proposal, position: null };
  }

  await createMonetaryProposalAcceptedNotification(result.proposal);

  revalidatePath(`/markets/${marketId}`);
  revalidatePath("/wallet");
  return { error: null, proposal: result.proposal, position: result.position };
}

export async function declineMonetaryProposalAction(proposalId: string, marketId: string): Promise<RespondToMonetaryProposalActionResult> {
  const user = await requireUser();

  const parsed = respondToMonetaryProposalSchema.safeParse({ proposalId });
  if (!parsed.success) {
    return { error: "Invalid proposal.", proposal: null, position: null };
  }

  let proposal: MonetaryProposal;
  try {
    proposal = await declineMonetaryProposal(parsed.data.proposalId, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: RESPOND_ERROR_COPY[message] ?? "Could not decline this proposal.", proposal: null, position: null };
  }

  await createMonetaryProposalDeclinedNotification(proposal);

  revalidatePath(`/markets/${marketId}`);
  return { error: null, proposal, position: null };
}

export async function withdrawMonetaryProposalAction(proposalId: string, marketId: string): Promise<RespondToMonetaryProposalActionResult> {
  const user = await requireUser();

  const parsed = respondToMonetaryProposalSchema.safeParse({ proposalId });
  if (!parsed.success) {
    return { error: "Invalid proposal.", proposal: null, position: null };
  }

  let proposal: MonetaryProposal;
  try {
    proposal = await withdrawMonetaryProposal(parsed.data.proposalId, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: RESPOND_ERROR_COPY[message] ?? "Could not withdraw this proposal.", proposal: null, position: null };
  }

  await createMonetaryProposalWithdrawnNotification(proposal);

  revalidatePath(`/markets/${marketId}`);
  revalidatePath("/wallet");
  return { error: null, proposal, position: null };
}
