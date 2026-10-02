import type { ComponentProps } from "react";
import Link from "next/link";
import { getMarketParticipants } from "@/lib/challenges/discovery";
import { isCallBsEnabled } from "@/lib/challenges/policy";
import { deriveChallengeActionState } from "@/lib/challenges/action-state";
import { listChallengesForMarketAndUser } from "@/lib/challenges/repository";
import { isPastEffectiveLock } from "@/lib/predictions/lock";
import { getPickLockPolicy } from "@/lib/predictions/policy";
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
export async function MarketParticipants({
  marketId,
  viewerId,
  yesLabel,
  noLabel,
  viewerHasPick,
}: {
  marketId: string;
  viewerId: string;
  /** Participants (and Call BS) only appear once the viewer has picked; before that, a one-line hint says so. */
  viewerHasPick: boolean;
  /** Stage 4A remediation (§13): semantic per-side labels, so "Picked X" never renders the raw YES/NO enum. */
  yesLabel: string;
  noLabel: string;
}) {
  const rawMarket = await getMarketById(marketId);
  if (rawMarket === null) return null;

  const scheduledStartUtc = await getFixtureScheduledStart(rawMarket.fixtureId);
  if (scheduledStartUtc === null) return null;

  if (!viewerHasPick) {
    // No names, picks or controls before the viewer has picked — only why
    // there is no Call BS yet, shown when there is someone to call BS on.
    const [participants, enabled, lockPolicy] = await Promise.all([
      getMarketParticipants(marketId, viewerId, scheduledStartUtc),
      isCallBsEnabled(),
      getPickLockPolicy(),
    ]);
    const open = !isPastEffectiveLock(scheduledStartUtc, lockPolicy.lockMinutesBeforeKickoff, new Date());
    if (!enabled || !open || participants.length === 0) return null;
    return <p className="text-xs text-text-muted">Make a pick to call BS on anyone who picked the other side.</p>;
  }

  const [participants, relevantChallenges, monetaryParticipants, relevantProposals, walletSummary, lockPolicy] = await Promise.all([
    getMarketParticipants(marketId, viewerId, scheduledStartUtc),
    listChallengesForMarketAndUser(marketId, viewerId),
    getMonetaryParticipants(marketId, viewerId, scheduledStartUtc),
    listMonetaryProposalsForMarketAndUser(marketId, viewerId),
    getWalletBalanceSummary(viewerId),
    getPickLockPolicy(),
  ]);
  // Same cutoff formula the Call BS discovery query and accept_call_bs()
  // use. A PENDING Challenge is only expired lazily in the database, so
  // the row has to be told about cutoff here rather than trusting status.
  const pastCutoff = isPastEffectiveLock(scheduledStartUtc, lockPolicy.lockMinutesBeforeKickoff, new Date());
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

  const actionByUserId = new Map(
    others.map((participant) => [
      participant.userId,
      deriveChallengeActionState({
        viewerId,
        participantPredictionId: participant.predictionId,
        canCallBs: participant.canCallBs,
        pairedInCallBs: participant.pairedInCallBs,
        challenges: relevantChallenges,
        pastCutoff,
      }),
    ]),
  );
  // The 1-v-1 rule from the viewer's side: once the viewer is in an
  // accepted Call BS, no other row offers one — say so rather than leave a
  // list of opposing picks with no button and no reason.
  const viewerOutcome = participants.find((p) => p.userId === viewerId)?.selectedOutcome;
  const viewerPaired = relevantChallenges.some((c) => c.status === "ACCEPTED");
  const showViewerPairedNote =
    viewerPaired && !pastCutoff && others.some((p) => p.selectedOutcome !== viewerOutcome && actionByUserId.get(p.userId)?.kind !== "accepted");

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Other picks</p>
      {showViewerPairedNote && <p className="text-xs text-text-muted">You&apos;re already in a Call BS on this game, so you can&apos;t call BS on anyone else.</p>}
      <ul className="space-y-2">
        {others.map((participant) => {
          const action = actionByUserId.get(participant.userId) ?? null;

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
            <li key={participant.userId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              {/* min-w-0 + truncate: a long display name must shrink inside
                  the row instead of pushing the actions off a 375px screen. */}
              <div className="flex min-w-0 items-center gap-2">
                <Link href={profileHref} className="shrink-0">
                  <Avatar displayName={participant.displayName} avatarUrl={participant.avatarUrl} size="sm" />
                </Link>
                <div className="min-w-0">
                  <Link href={profileHref} className="block truncate text-sm font-medium text-text-primary hover:underline">
                    {participant.displayName}
                  </Link>
                  <p className="break-words text-xs text-text-muted">Picked {participant.selectedOutcome === "YES" ? yesLabel : noLabel}</p>
                </div>
              </div>
              {/* Below sm the controls drop under the identity (aligned with
                  it) instead of competing with it for width; from sm up they
                  sit to its right as before. */}
              <div className="flex shrink-0 flex-col items-start gap-2 pl-8 sm:items-end sm:gap-1 sm:pl-0">
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
