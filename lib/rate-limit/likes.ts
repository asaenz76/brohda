import "server-only";
import { checkRateLimit } from "./check";

const LIKE_WINDOW_SECONDS = 60;
const LIKE_MAX_ATTEMPTS = 60;

/**
 * Per-user cap on like/unlike toggles — generous since scrolling a feed and
 * tapping hearts is a high-frequency action, tight enough to catch a
 * scripted flood. `unique_pool_like` is the correctness backstop either way.
 */
export async function checkLikeRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(`like:${userId}`, LIKE_WINDOW_SECONDS, LIKE_MAX_ATTEMPTS);
}
