import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MonetaryPosition, MonetaryPositionSettlement } from "@/lib/monetary/types";
import { formatCents } from "@/lib/utils/money";

// Milestone R10 §52-53. Mirrors lib/notifications/monetary-proposals.ts's
// own plain-TS-copy simplicity. Fired only from the settlement runner
// (scripts/settle-monetary-positions.ts), and only AFTER
// settleMonetaryPosition() has already committed successfully (§53) —
// never before, and never speculatively. Deliberately the only place in
// this codebase that ever says "you won"/"you lost" about real money —
// R9's own notifications (lib/notifications/monetary-proposals.ts)
// explicitly never do this, since R9 never knew a result.

async function getMarketQuestion(marketId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("markets").select("question").eq("id", marketId).maybeSingle();
  return data?.question ?? "a market";
}

/** Fired once per WIN settlement — to the winner only. The loser's own outcome is conveyed by createPositionLossNotification below, not implied here. */
export async function createPositionWinNotification(position: MonetaryPosition, settlement: MonetaryPositionSettlement): Promise<void> {
  if (settlement.outcome === "VOID" || !settlement.winnerUserId) return;
  const admin = createAdminClient();
  const question = await getMarketQuestion(position.marketId);

  await admin.from("notifications").insert({
    user_id: settlement.winnerUserId,
    type: "MONETARY_POSITION_SETTLED_WIN",
    title: "You won",
    body: `You won ${formatCents(settlement.winnerCreditAmount)} on "${question}".`,
    monetary_proposal_id: position.proposalId,
  });
}

/** Fired once per WIN settlement — to the loser. */
export async function createPositionLossNotification(position: MonetaryPosition, settlement: MonetaryPositionSettlement): Promise<void> {
  if (settlement.outcome === "VOID" || !settlement.loserUserId) return;
  const admin = createAdminClient();
  const question = await getMarketQuestion(position.marketId);

  await admin.from("notifications").insert({
    user_id: settlement.loserUserId,
    type: "MONETARY_POSITION_SETTLED_LOSS",
    title: "You lost",
    body: `You lost ${formatCents(settlement.stake)} on "${question}".`,
    monetary_proposal_id: position.proposalId,
  });
}

/** Fired once per VOID settlement — to both participants, since neither wins nor loses. */
export async function createPositionVoidedNotifications(position: MonetaryPosition, settlement: MonetaryPositionSettlement): Promise<void> {
  if (settlement.outcome !== "VOID") return;
  const admin = createAdminClient();
  const question = await getMarketQuestion(position.marketId);
  const body = `Your position on "${question}" was voided. Your ${formatCents(settlement.stake)} hold was released.`;

  await admin.from("notifications").insert([
    { user_id: position.proposerUserId, type: "MONETARY_POSITION_VOIDED", title: "Position voided", body, monetary_proposal_id: position.proposalId },
    { user_id: position.recipientUserId, type: "MONETARY_POSITION_VOIDED", title: "Position voided", body, monetary_proposal_id: position.proposalId },
  ]);
}

/** Dispatches the correct notification(s) for a just-settled Position — the one entrypoint the runner script actually calls. */
export async function createSettlementNotifications(position: MonetaryPosition, settlement: MonetaryPositionSettlement): Promise<void> {
  if (settlement.outcome === "VOID") {
    await createPositionVoidedNotifications(position, settlement);
    return;
  }
  await Promise.all([createPositionWinNotification(position, settlement), createPositionLossNotification(position, settlement)]);
}
