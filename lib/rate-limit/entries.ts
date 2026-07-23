import "server-only";
import { checkRateLimit } from "./check";

const ENTRY_WINDOW_SECONDS = 60;
const ENTRY_MAX_ATTEMPTS = 20;

/**
 * Per-user cap on entry submissions (spec §19). Generous enough not to
 * block a legitimate double-tap/retry, tight enough to catch a scripted
 * flood — `create_pool_entry`'s own idempotency/uniqueness checks are the
 * correctness backstop either way; this is just abuse throttling.
 */
export async function checkEntryRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(`entry:${userId}`, ENTRY_WINDOW_SECONDS, ENTRY_MAX_ATTEMPTS);
}
