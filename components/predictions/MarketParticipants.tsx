import type { ComponentProps } from "react";
import Link from "next/link";
import { getMarketParticipants } from "@/lib/challenges/discovery";
import { listChallengesForMarketAndUser } from "@/lib/challenges/repository";
import { getMonetaryParticipants } from "@/lib/monetary/discovery";
import { listMonetaryProposalsForMarketAndUser, listMonetaryPositionsByIds, listMonetaryPositionSettlementsByPositionIds } from "@/lib/monetary/repository";
import { getWalletBalanceSummary } from "@/lib/wallet/reservations";
import { getFixtureScheduledStart } from "@/lib/sports-data/fixture-lookup";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { Avatar } from "@/components/Avatar";
import { ChallengeAction } from "@/components/predictions/ChallengeAction";
import { MonetaryProposalAction } from "@/components/predictions/MonetaryProposalAction";

// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges),
// §42-43, §47: the minimal Post/Market social surface Call BS needs — who
// else picked what on this Market, and (for an opposing pick) a Call BS
// control, or the current state of any existing Challenge between the
// viewer and that participant. Mounted inside MarketPredictionCard, so it
// automatically appears on both /markets/[id] and /post/[id] without
// duplicating wiring.
//
// Milestone R9 extends this SAME row with an independent monetary action
// (getMonetaryParticipants/listMonetaryProposalsForMarketAndUser are their
// own separate data path, mirroring the backend's own Proposal/Position-
// is-not-a-Challenge separation) rather than rendering a second, duplicate
// participant list — an earlier attempt at a sibling MonetaryParticipants
// component repeated each participant's identity/"Picked X" line a second
// time on the page, which broke Playwright's strict-mode text matching in
// both the new monetary E2E spec AND this file's own pre-existing R7 spec
// (two "Picked YES" nodes suddenly matched one locator). One row, both
// independent actions, is both correct and simpler.
export async function MarketParticipants({ marketId, viewerId }: { marketId: string; viewerId: string }) {
  const rawMarket = await getMarketById(marketId);
  if (rawMarket === null) return null;

  const scheduledStartUtc = await getFixtureScheduledStart(rawMarket.fixtureId);
  if (scheduledStartUtc === null) return null;

  const [participants, relevantChallenges, monetaryParticipants, relevantProposals, walletSummary] = await Promise.all([
    getMarketParticipants(marketId, viewerId, scheduledStartUtc),
    listChallengesForMarketAndUser(marketId, viewerId),
    getMonetaryParticipants(marketId, viewerId, scheduledStartUtc),
    listMonetaryProposalsForMarketAndUser(marketId, viewerId),
    getWalletBalanceSummary(viewerId),
  ]);
  const monetaryByUserId = new Map(monetaryParticipants.map((p) => [p.userId, p]));

  // Milestone R10 (§55): resolve every ACCEPTED proposal's Position (and,
  // once terminal, its settlement) in two batched queries rather than one
  // per participant row.
  const acceptedPositionIds = relevantProposals.filter((p) => p.status === "ACCEPTED" && p.positionId).map((p) => p.positionId as string);
  const positions = await listMonetaryPositionsByIds(acceptedPositionIds);
  const positionsById = new Map(positions.map((p) => [p.id, p]));
  const terminalPositionIds = positions.filter((p) => p.settlementStatus !== "COMMITTED").map((p) => p.id);
  const settlements = await listMonetaryPositionSettlementsByPositionIds(terminalPositionIds);
  const settlementsByPositionId = new Map(settlements.map((s) => [s.positionId, s]));

  const others = participants.filter((p) => p.userId !== viewerId);
  if (others.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Other picks</p>
      <ul className="space-y-2">
        {others.map((participant) => {
          const active = relevantChallenges.find(
            (c) =>
              (c.status === "PENDING" || c.status === "ACCEPTED") &&
              ((c.challengerUserId === viewerId && c.recipientPredictionId === participant.predictionId) ||
                (c.recipientUserId === viewerId && c.challengerPredictionId === participant.predictionId)),
          );

          let action: ComponentProps<typeof ChallengeAction>["state"] | null = null;
          if (active) {
            if (active.status === "ACCEPTED") action = { kind: "accepted" };
            else if (active.challengerUserId === viewerId) action = { kind: "outgoing_pending" };
            else action = { kind: "incoming_pending", challengeId: active.id };
          } else if (participant.canCallBs) {
            action = { kind: "call_bs", recipientPredictionId: participant.predictionId };
          }

          const monetaryParticipant = monetaryByUserId.get(participant.userId);
          const activeProposal = relevantProposals.find(
            (p) =>
              (p.status === "PENDING" || p.status === "ACCEPTED") &&
              ((p.proposerUserId === viewerId && p.recipientPredictionId === participant.predictionId) ||
                (p.recipientUserId === viewerId && p.proposerPredictionId === participant.predictionId)),
          );

          let monetaryAction: ComponentProps<typeof MonetaryProposalAction>["state"] | null = null;
          if (activeProposal) {
            if (activeProposal.status === "ACCEPTED") {
              const position = activeProposal.positionId ? positionsById.get(activeProposal.positionId) : undefined;
              const settlement = position ? settlementsByPositionId.get(position.id) : undefined;
              if (settlement) {
                if (settlement.outcome === "VOID") {
                  monetaryAction = { kind: "settled_void" };
                } else if (settlement.winnerUserId === viewerId) {
                  monetaryAction = { kind: "settled_win", amount: settlement.winnerCreditAmount };
                } else {
                  monetaryAction = { kind: "settled_loss", amount: settlement.stake };
                }
              } else {
                monetaryAction = { kind: "committed", stake: activeProposal.stake };
              }
            } else if (activeProposal.proposerUserId === viewerId) {
              monetaryAction = { kind: "outgoing_pending", proposalId: activeProposal.id, stake: activeProposal.stake };
            } else if (walletSummary.available >= activeProposal.stake) {
              monetaryAction = { kind: "incoming_pending_funded", proposalId: activeProposal.id, stake: activeProposal.stake };
            } else {
              monetaryAction = { kind: "incoming_pending_unfunded", proposalId: activeProposal.id, stake: activeProposal.stake };
            }
          } else if (monetaryParticipant?.canProposeMoney) {
            monetaryAction = { kind: "put_money_on_it", recipientPredictionId: participant.predictionId };
          }

          const profileHref = `/profile/${participant.username ?? participant.userId}`;
          return (
            <li key={participant.userId} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Link href={profileHref}>
                  <Avatar displayName={participant.displayName} avatarUrl={participant.avatarUrl} size="sm" />
                </Link>
                <div>
                  <Link href={profileHref} className="text-sm font-medium text-text-primary hover:underline">
                    {participant.displayName}
                  </Link>
                  <p className="text-xs text-text-muted">Picked {participant.selectedOutcome}</p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {action && <ChallengeAction marketId={marketId} state={action} />}
                {monetaryAction && <MonetaryProposalAction marketId={marketId} state={monetaryAction} />}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
