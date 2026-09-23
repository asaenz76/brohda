import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MonetaryProposal } from "@/lib/monetary/types";

// Milestone R9 §68-71. Mirrors lib/notifications/challenges.ts's own plain-
// TS-copy simplicity exactly. Deliberately covers only proposal-lifecycle
// events (received/accepted/declined/withdrawn) — no settlement/payout/
// "you won" notification exists here, matching R9's own explicit
// prohibition (settlement is R10's responsibility, not this milestone's).
// Every recipient is always derived from MonetaryProposal state
// (proposerUserId/recipientUserId, both immutable, set only by
// propose_money() itself) — never accepted from a client.

async function getMarketQuestion(marketId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("markets").select("question").eq("id", marketId).maybeSingle();
  return data?.question ?? "a market";
}

async function getDisplayName(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("user_profiles").select("display_name").eq("id", userId).maybeSingle();
  return data?.display_name ?? "Someone";
}

function formatStake(stakeCents: number): string {
  return `$${(stakeCents / 100).toFixed(2)}`;
}

/** The recipient learns a specific user proposed money on their opposing Pick. */
export async function createMonetaryProposalReceivedNotification(proposal: MonetaryProposal): Promise<void> {
  const admin = createAdminClient();
  const [proposerName, question] = await Promise.all([getDisplayName(proposal.proposerUserId), getMarketQuestion(proposal.marketId)]);

  await admin.from("notifications").insert({
    user_id: proposal.recipientUserId,
    type: "MONETARY_PROPOSAL_RECEIVED",
    title: "Someone put money on it",
    body: `${proposerName} proposed ${formatStake(proposal.stake)} on your pick on "${question}".`,
    monetary_proposal_id: proposal.id,
  });
}

/** The proposer learns the recipient accepted — a Position now exists. */
export async function createMonetaryProposalAcceptedNotification(proposal: MonetaryProposal): Promise<void> {
  const admin = createAdminClient();
  const [recipientName, question] = await Promise.all([getDisplayName(proposal.recipientUserId), getMarketQuestion(proposal.marketId)]);

  await admin.from("notifications").insert({
    user_id: proposal.proposerUserId,
    type: "MONETARY_PROPOSAL_ACCEPTED",
    title: "Your proposal was accepted",
    body: `${recipientName} accepted your ${formatStake(proposal.stake)} proposal on "${question}". Both picks are locked in.`,
    monetary_proposal_id: proposal.id,
  });
}

/** The proposer learns the recipient declined — their reservation was released. */
export async function createMonetaryProposalDeclinedNotification(proposal: MonetaryProposal): Promise<void> {
  const admin = createAdminClient();
  const [recipientName, question] = await Promise.all([getDisplayName(proposal.recipientUserId), getMarketQuestion(proposal.marketId)]);

  await admin.from("notifications").insert({
    user_id: proposal.proposerUserId,
    type: "MONETARY_PROPOSAL_DECLINED",
    title: "Your proposal was declined",
    body: `${recipientName} declined your ${formatStake(proposal.stake)} proposal on "${question}".`,
    monetary_proposal_id: proposal.id,
  });
}

/** The recipient learns the proposer withdrew — purely informational, no reservation impact on their side (they never had one). */
export async function createMonetaryProposalWithdrawnNotification(proposal: MonetaryProposal): Promise<void> {
  const admin = createAdminClient();
  const [proposerName, question] = await Promise.all([getDisplayName(proposal.proposerUserId), getMarketQuestion(proposal.marketId)]);

  await admin.from("notifications").insert({
    user_id: proposal.recipientUserId,
    type: "MONETARY_PROPOSAL_WITHDRAWN",
    title: "A proposal was withdrawn",
    body: `${proposerName} withdrew their ${formatStake(proposal.stake)} proposal on "${question}".`,
    monetary_proposal_id: proposal.id,
  });
}
