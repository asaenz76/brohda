// Brohda 2.1 M4 — how one Call BS reads to one of its two Members, in every state. Pure and client-safe: no I/O, no clock, so it is unit-tested state by state and the wording lives in exactly one place.
//
// The state itself is never decided here. It comes from the stored challenge (status, result, expiry reason), exactly as the profile history and the notifications read it; the only extra input is whether
// the pick deadline has passed, because an unanswered PENDING Call BS is only swept to EXPIRED lazily in the database (lib/challenges/action-state.ts explains why). Nothing here says anything about money.

import type { Challenge } from "./types";

export type ChallengeTone = "action" | "waiting" | "locked" | "won" | "lost" | "void" | "ended";

export interface ChallengeStatusView {
  tone: ChallengeTone;
  /** The one line that says where this Call BS stands, from the viewer's side. */
  headline: string;
  /** Who picked what, and what happens next. Always plain text (a state is never carried by colour alone). */
  detail: string;
  /** True only for an incoming PENDING Call BS the viewer can still answer. */
  canRespond: boolean;
  /** The viewer's result once RESOLVED; null otherwise. */
  outcome: "WON" | "LOST" | "VOID" | null;
}

export interface DescribeChallengeInput {
  challenge: Challenge;
  viewerId: string;
  /** The other Member's display name. */
  opponentName: string;
  /** What the viewer picked and what the opponent picked, as the Game reads it ("Philadelphia Eagles"), taken from the stored snapshots. */
  yourPickLabel: string;
  theirPickLabel: string;
  /** The canonical pick deadline has passed (see isPastEffectiveLock). */
  pastCutoff: boolean;
}

/** The viewer's result of a RESOLVED Call BS, from the stored winner only (never from a current Pick, a comment or a profile). */
export function challengeOutcomeForViewer(challenge: Pick<Challenge, "challengerUserId" | "result">, viewerId: string): "WON" | "LOST" | "VOID" {
  if (challenge.result === null || challenge.result === "VOID") return "VOID";
  const viewerIsChallenger = challenge.challengerUserId === viewerId;
  const challengerWon = challenge.result === "CHALLENGER_WON";
  return viewerIsChallenger === challengerWon ? "WON" : "LOST";
}

export function describeChallengeForViewer({ challenge, viewerId, opponentName, yourPickLabel, theirPickLabel, pastCutoff }: DescribeChallengeInput): ChallengeStatusView {
  const viewerIsChallenger = challenge.challengerUserId === viewerId;
  const sides = `You picked ${yourPickLabel}. ${opponentName} picked ${theirPickLabel}.`;
  const base = { canRespond: false, outcome: null } as const;

  switch (challenge.status) {
    case "PENDING": {
      if (pastCutoff) {
        return {
          ...base,
          tone: "ended",
          headline: `Call BS with ${opponentName} expired`,
          detail: viewerIsChallenger ? `${opponentName} didn't answer before picks locked.` : `You didn't answer before picks locked.`,
        };
      }
      if (viewerIsChallenger) {
        return { ...base, tone: "waiting", headline: `You called BS on ${opponentName}`, detail: `${sides} Waiting for ${opponentName} to accept. It expires when picks lock.` };
      }
      return {
        tone: "action",
        canRespond: true,
        outcome: null,
        headline: `${opponentName} called BS on you`,
        detail: `${sides} Accept and both picks lock. The final score decides who was right.`,
      };
    }
    case "ACCEPTED":
      return { ...base, tone: "locked", headline: `Call BS accepted: you vs ${opponentName}`, detail: `${sides} Both picks are locked. The final score decides who was right.` };
    case "RESOLVED": {
      const outcome = challengeOutcomeForViewer(challenge, viewerId);
      if (outcome === "VOID") {
        return { canRespond: false, outcome, tone: "void", headline: `Call BS with ${opponentName} void`, detail: `${sides} The game didn't produce a result, so nobody wins.` };
      }
      const caller = viewerIsChallenger ? `You called BS on ${opponentName}` : `${opponentName} called BS on you`;
      const verdict = outcome === "WON" ? "you were right" : `${opponentName} was right`;
      return { canRespond: false, outcome, tone: outcome === "WON" ? "won" : "lost", headline: `${caller}: ${verdict}`, detail: `${sides} The final result decided it.` };
    }
    case "DECLINED":
      return {
        ...base,
        tone: "ended",
        headline: viewerIsChallenger ? `${opponentName} declined your Call BS` : `You declined ${opponentName}'s Call BS`,
        detail: "Nothing was locked.",
      };
    case "EXPIRED":
      if (challenge.expiryReason === "PICK_CHANGED") {
        return { ...base, tone: "ended", headline: `Call BS with ${opponentName} cancelled`, detail: `A pick changed, so you and ${opponentName} no longer disagree on this game.` };
      }
      if (challenge.expiryReason === "NO_RESPONSE") {
        return {
          ...base,
          tone: "ended",
          headline: `Call BS with ${opponentName} expired`,
          detail: viewerIsChallenger ? `${opponentName} didn't answer before picks locked.` : `You didn't answer before picks locked.`,
        };
      }
      return { ...base, tone: "ended", headline: `Call BS with ${opponentName} is no longer available`, detail: "It ended before it could be accepted. Nothing was locked." };
  }
}

/** Display order for a viewer's Call BS on one Game: what needs an answer first, then what is live, then what is decided, then what ended. */
const TONE_ORDER: Record<ChallengeTone, number> = { action: 0, locked: 1, waiting: 2, won: 3, lost: 3, void: 3, ended: 4 };

export function sortChallengeViews<T extends { view: ChallengeStatusView; challenge: Challenge }>(items: T[]): T[] {
  return [...items].sort((a, b) => TONE_ORDER[a.view.tone] - TONE_ORDER[b.view.tone] || b.challenge.updatedAt.localeCompare(a.challenge.updatedAt) || a.challenge.id.localeCompare(b.challenge.id));
}
