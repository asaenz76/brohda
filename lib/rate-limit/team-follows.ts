import "server-only";
import { checkRateLimit } from "./check";

const TEAM_FOLLOW_WINDOW_SECONDS = 60;
const TEAM_FOLLOW_MAX_ATTEMPTS = 30;

/**
 * Per-user cap on team/league follow/unfollow toggles — same shape as
 * checkFollowRateLimit (lib/rate-limit/follows.ts): generous enough for
 * normal browsing, tight enough to catch a scripted flood. The relevant
 * unique index (unique_team_follow/unique_league_follow) is the
 * correctness backstop either way.
 */
export async function checkTeamFollowRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(`team_follow:${userId}`, TEAM_FOLLOW_WINDOW_SECONDS, TEAM_FOLLOW_MAX_ATTEMPTS);
}

export async function checkLeagueFollowRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(`league_follow:${userId}`, TEAM_FOLLOW_WINDOW_SECONDS, TEAM_FOLLOW_MAX_ATTEMPTS);
}
