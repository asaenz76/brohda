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
import { getMarketById, listChoiceSourcesByMarketIds } from "@/lib/prediction-markets/repository";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { Avatar } from "@/components/Avatar";
import { ChallengeAction } from "@/components/predictions/ChallengeAction";
import { HeadToHeadLine } from "@/components/profile/CallBsRecordLine";
import { getHeadToHeadRecords } from "@/lib/challenges/history";
import { MonetaryProposalAction } from "@/components/predictions/MonetaryProposalAction";
import { deriveMonetaryActionState } from "@/lib/monetary/action-state";
import { getMonetaryStakeLimits, getP2pFeeBps } from "@/lib/monetary/policy";
import { isConsumerMonetaryEnabled } from "@/lib/monetary/capability";

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
  viewerHasPick,
}: {
  marketId: string;
  viewerId: string;
  /** Participants (and Call BS) only appear once the viewer has picked; before that, a one-line hint says so. */
  viewerHasPick: boolean;
}) {
  const rawMarket = await getMarketById(marketId);
  if (rawMarket === null) return null;
  // What each canonical side reads as ("Picked Washington Commanders"), from the same shared presentation every other surface uses.
  const choiceSource = (await listChoiceSourcesByMarketIds([marketId])).get(marketId) ?? rawMarket;
  const labelFor = (outcome: "YES" | "NO") => getSelectionLabel(choiceSource, outcome);

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

  const [participants, relevantChallenges, monetaryParticipants, relevantProposals, walletSummary, lockPolicy, feeBps, stakeLimits, moneyEnabled] = await Promise.all([
    getMarketParticipants(marketId, viewerId, scheduledStartUtc),
    listChallengesForMarketAndUser(marketId, viewerId),
    getMonetaryParticipants(marketId, viewerId, scheduledStartUtc),
    listMonetaryProposalsForMarketAndUser(marketId, viewerId),
    getWalletBalanceSummary(viewerId),
    getPickLockPolicy(),
    getP2pFeeBps(),
    // Fail closed: with no readable limits we offer no NEW money action rather than guess a limit. Existing proposals/Positions still render.
    getMonetaryStakeLimits().catch(() => null),
    // The consumer money capability (fail-closed). When off, no new offer is shown, an incoming pending offer can only be declined,
    // and only existing obligations (a pending offer you sent, a committed or settled Position) remain visible.
    isConsumerMonetaryEnabled(),
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

  // The viewer's resolved Call BS record against each person on this list, in one batched read. Only RESOLVED challenges count,
  // so a pending or accepted-but-ungraded one is never in it; the line below appears only where there is history to show.
  const headToHead = await getHeadToHeadRecords(
    viewerId,
    others.map((p) => p.userId),
  );

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
          const monetaryAction = deriveMonetaryActionState({
            viewerId,
            participantPredictionId: participant.predictionId,
            canProposeMoney: Boolean(monetaryParticipant?.canProposeMoney) && stakeLimits !== null,
            proposals: relevantProposals,
            positionsById,
            settlementsByPositionId,
            viewerAvailableCents: walletSummary.available,
            pastCutoff,
            moneyEnabled,
          });

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
                  <p className="break-words text-xs text-text-muted">Picked {labelFor(participant.selectedOutcome)}</p>
                  {(() => {
                    const record = headToHead.get(participant.userId);
                    return record ? <HeadToHeadLine opponentName={participant.displayName} wins={record.wins} losses={record.losses} /> : null;
                  })()}
                </div>
              </div>
              {/* Below sm the controls drop under the identity (aligned with
                  it) instead of competing with it for width; from sm up they
                  sit to its right as before. */}
              <div className="flex shrink-0 flex-col items-start gap-2 pl-8 sm:items-end sm:gap-1 sm:pl-0">
                {action && <ChallengeAction marketId={marketId} state={action} />}
                {monetaryAction && (
                  <MonetaryProposalAction
                    marketId={marketId}
                    state={monetaryAction}
                    context={{
                      opponentName: participant.displayName,
                      yourPickLabel: labelFor(viewerOutcome ?? "YES"),
                      theirPickLabel: labelFor(participant.selectedOutcome),
                      feeBps,
                      availableCents: walletSummary.available,
                      minStakeCents: stakeLimits?.minStakeCents ?? 0,
                      maxStakeCents: stakeLimits?.maxStakeCents ?? 0,
                    }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
