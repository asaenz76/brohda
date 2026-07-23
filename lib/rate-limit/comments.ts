import "server-only";
import { checkRateLimit } from "./check";

const COMMENT_WINDOW_SECONDS = 60;
const COMMENT_MAX_ATTEMPTS = 10;

/**
 * Per-user cap on new comments — free-text is a materially different abuse
 * surface than a like/follow toggle (spam, flooding), so this is tighter
 * than those. There's no moderation system beyond this and the self/admin-
 * delete affordance in delete_pool_comment().
 */
export async function checkCommentRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(`comment:${userId}`, COMMENT_WINDOW_SECONDS, COMMENT_MAX_ATTEMPTS);
}
