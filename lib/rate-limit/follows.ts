import "server-only";
import { checkRateLimit } from "./check";

const FOLLOW_WINDOW_SECONDS = 60;
const FOLLOW_MAX_ATTEMPTS = 30;

/**
 * Per-user cap on follow/unfollow toggles — generous enough for normal
 * browsing (following several profiles in a row), tight enough to catch a
 * scripted flood. `unique_follow` is the correctness backstop either way.
 */
export async function checkFollowRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(`follow:${userId}`, FOLLOW_WINDOW_SECONDS, FOLLOW_MAX_ATTEMPTS);
}
