import "server-only";
import { isPastEffectiveLock } from "@/lib/predictions/lock";
import type { PredictionOutcome } from "@/lib/predictions/types";
import { getMarketParticipants } from "./discovery";
import { deriveChallengeActionState, withIncomingAnsweredAbove, type ChallengeActionState } from "./action-state";
import { getHeadToHeadRecords, type HeadToHeadRecord } from "./history";
import { listChallengesForMarketAndUser } from "./repository";
import type { Challenge, ChallengeParticipant } from "./types";

// Brohda 2.1 M4 — what the Post knows about the other Members' sides, read ONCE and shared by the two places that show it: the conversation (a side badge and, for the other side, Call BS inside the comment) and
// the "Other picks" list (everyone else who picked). Nothing here is new product logic: the participants, their eligibility and each Call BS state come from the same functions MarketParticipants always used
// (getMarketParticipants, deriveChallengeActionState, getHeadToHeadRecords); this file only stops the Post from reading them twice and puts them in one shape.
//
// Commit-before-crowd: with no Pick of their own the viewer gets nothing from here (no names, no sides, no controls), exactly as before. The server stays authoritative: a button shown here is only an offer, and
// call_bs() / accept_call_bs() re-check everything.

/** One Member's side on the primary Market, from the viewer's point of view. */
export interface PostSocialSide {
  displayName: string;
  outcome: PredictionOutcome;
  /** What that side reads as on this Game ("Philadelphia Eagles"). The Member's CURRENT Pick: final once picks lock. */
  label: string;
  relation: "self" | "same" | "opposite";
  /** The Call BS control or status for this Member, null when none applies. Incoming Call BS is answered in the "Your Call BS" block, so it reads "called on you" here. */
  action: ChallengeActionState | null;
  /** The viewer's resolved Call BS record against this Member, only when there is one. */
  headToHead: { wins: number; losses: number } | null;
}

/** What the client conversation needs: a plain object, so it can cross the Server -> Client boundary. */
export interface ConversationSocial {
  marketId: string;
  viewer: { outcome: PredictionOutcome; label: string };
  /** The label of the side the viewer did not pick. */
  otherLabel: string;
  byUserId: Record<string, PostSocialSide>;
}

/** Everything read for the Post, including what only the server-side "Other picks" list needs (it never crosses to the client). */
export interface PostSocial extends ConversationSocial {
  participants: ChallengeParticipant[];
  challenges: Challenge[];
  headToHead: Map<string, HeadToHeadRecord>;
  pastCutoff: boolean;
}

/** The part of a PostSocial the client conversation receives. */
export function toConversationSocial(social: PostSocial): ConversationSocial {
  return { marketId: social.marketId, viewer: social.viewer, otherLabel: social.otherLabel, byUserId: social.byUserId };
}

export interface PostSocialInput {
  marketId: string;
  viewerId: string;
  participants: ChallengeParticipant[];
  challenges: Challenge[];
  headToHead: Map<string, HeadToHeadRecord>;
  pastCutoff: boolean;
  labelFor: (outcome: PredictionOutcome) => string;
}

const opposite = (outcome: PredictionOutcome): PredictionOutcome => (outcome === "YES" ? "NO" : "YES");

/** Pure: the shared shape from what the database returned. Null when the viewer has no Pick on this Market. */
export function buildPostSocial({ marketId, viewerId, participants, challenges, headToHead, pastCutoff, labelFor }: PostSocialInput): PostSocial | null {
  const viewerRow = participants.find((p) => p.userId === viewerId);
  if (!viewerRow) return null;

  const byUserId: Record<string, PostSocialSide> = {};
  for (const participant of participants) {
    const isSelf = participant.userId === viewerId;
    const record = headToHead.get(participant.userId);
    byUserId[participant.userId] = {
      displayName: participant.displayName,
      outcome: participant.selectedOutcome,
      label: labelFor(participant.selectedOutcome),
      relation: isSelf ? "self" : participant.selectedOutcome === viewerRow.selectedOutcome ? "same" : "opposite",
      action: isSelf
        ? null
        : withIncomingAnsweredAbove(
            deriveChallengeActionState({
              viewerId,
              participantPredictionId: participant.predictionId,
              canCallBs: participant.canCallBs,
              pairedInCallBs: participant.pairedInCallBs,
              challenges,
              pastCutoff,
            }),
          ),
      headToHead: record && record.wins + record.losses > 0 ? { wins: record.wins, losses: record.losses } : null,
    };
  }

  return {
    marketId,
    viewer: { outcome: viewerRow.selectedOutcome, label: labelFor(viewerRow.selectedOutcome) },
    otherLabel: labelFor(opposite(viewerRow.selectedOutcome)),
    byUserId,
    participants,
    challenges,
    headToHead,
    pastCutoff,
  };
}

/** Reads what buildPostSocial needs: three batched reads (participants, the viewer's challenges on the Market, head-to-head records), the same ones the Other-picks list made before. */
export async function loadPostSocial({
  marketId,
  viewerId,
  scheduledStartUtc,
  lockMinutesBeforeKickoff,
  labelFor,
}: {
  marketId: string;
  viewerId: string;
  scheduledStartUtc: string;
  lockMinutesBeforeKickoff: number;
  labelFor: (outcome: PredictionOutcome) => string;
}): Promise<PostSocial | null> {
  const [participants, challenges] = await Promise.all([getMarketParticipants(marketId, viewerId, scheduledStartUtc), listChallengesForMarketAndUser(marketId, viewerId)]);
  if (!participants.some((p) => p.userId === viewerId)) return null;
  const headToHead = await getHeadToHeadRecords(
    viewerId,
    participants.map((p) => p.userId),
  );
  return buildPostSocial({
    marketId,
    viewerId,
    participants,
    challenges,
    headToHead,
    pastCutoff: isPastEffectiveLock(scheduledStartUtc, lockMinutesBeforeKickoff, new Date()),
    labelFor,
  });
}
