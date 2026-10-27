import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listChoiceSourcesByMarketIds } from "@/lib/prediction-markets/repository";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import type { PredictionOutcome } from "@/lib/predictions/types";
import { describeChallengeForViewer, sortChallengeViews, type ChallengeStatusView } from "./presentation";
import { listChallengesForMarketsAndUser } from "./repository";
import type { Challenge } from "./types";

// Brohda 2.1 M4 — "Your Call BS" on a Game: every Call BS the viewer is in on this Game's Markets, in every state, so a Member opening the Post (from a notification, or after the Game) sees what is waiting for them,
// what is locked, and who won — without opening a profile. Read from the stored challenges (the same rows the profile history and the notifications read); nothing is counted or cached here. (The head-to-head
// record is not repeated in this block: it already sits beside the opponent in the conversation and in "Other picks".) A constant number of batched reads however many Call BS there are.

/** How many Call BS the block lists before saying "and N more": a presentation size, not product policy. */
export const GAME_CALL_BS_VISIBLE_LIMIT = 6;

export interface GameCallBsItem {
  challenge: Challenge;
  view: ChallengeStatusView;
  opponent: { id: string; name: string; username: string | null };
}

export interface GameCallBsStatus {
  items: GameCallBsItem[];
  /** Call BS beyond the visible limit. */
  more: number;
}

export interface GameCallBsInput {
  viewerId: string;
  challenges: Challenge[];
  profiles: Map<string, { name: string; username: string | null }>;
  /** What each side of each Market reads as on this Game. */
  labelFor: (marketId: string, outcome: PredictionOutcome) => string;
  pastCutoff: boolean;
  limit?: number;
}

/** Pure: the viewer's Call BS on the Game, in display order (needs an answer, then live, then decided, then ended). */
export function buildGameCallBsStatus({ viewerId, challenges, profiles, labelFor, pastCutoff, limit = GAME_CALL_BS_VISIBLE_LIMIT }: GameCallBsInput): GameCallBsStatus {
  const items = challenges.map((challenge): GameCallBsItem => {
    const viewerIsChallenger = challenge.challengerUserId === viewerId;
    const opponentId = viewerIsChallenger ? challenge.recipientUserId : challenge.challengerUserId;
    const profile = profiles.get(opponentId);
    const name = profile?.name ?? "A Member";
    // The sides as they were when the Call BS was made (the stored snapshots), never today's live Pick.
    const yours = viewerIsChallenger ? challenge.challengerSelectionSnapshot : challenge.recipientSelectionSnapshot;
    const theirs = viewerIsChallenger ? challenge.recipientSelectionSnapshot : challenge.challengerSelectionSnapshot;
    return {
      challenge,
      view: describeChallengeForViewer({ challenge, viewerId, opponentName: name, yourPickLabel: labelFor(challenge.marketId, yours), theirPickLabel: labelFor(challenge.marketId, theirs), pastCutoff }),
      opponent: { id: opponentId, name, username: profile?.username ?? null },
    };
  });
  const sorted = sortChallengeViews(items);
  return { items: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}

export async function loadGameCallBsStatus({ viewerId, marketIds, pastCutoff }: { viewerId: string; marketIds: string[]; pastCutoff: boolean }): Promise<GameCallBsStatus> {
  const challenges = await listChallengesForMarketsAndUser(marketIds, viewerId);
  if (challenges.length === 0) return { items: [], more: 0 };

  const opponentIds = [...new Set(challenges.map((c) => (c.challengerUserId === viewerId ? c.recipientUserId : c.challengerUserId)))];
  const [{ data: profileRows, error }, sources] = await Promise.all([
    createAdminClient().from("user_profiles").select("id, display_name, username").in("id", opponentIds),
    listChoiceSourcesByMarketIds([...new Set(challenges.map((c) => c.marketId))]),
  ]);
  if (error) throw error;
  const profiles = new Map((profileRows ?? []).map((p) => [p.id, { name: p.display_name?.trim() || p.username?.trim() || "A Member", username: p.username as string | null }]));

  return buildGameCallBsStatus({
    viewerId,
    challenges,
    profiles,
    labelFor: (marketId, outcome) => {
      const source = sources.get(marketId);
      return source ? getSelectionLabel(source, outcome) : outcome === "YES" ? "Yes" : "No";
    },
    pastCutoff,
  });
}
