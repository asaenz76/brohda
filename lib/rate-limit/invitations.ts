import "server-only";
import { checkRateLimit } from "./check";

const INVITE_LOOKUP_WINDOW_SECONDS = 10 * 60;
const INVITE_LOOKUP_MAX_ATTEMPTS = 20;

/**
 * Per-token cap on invitation-link resolution (spec §19's "share-link
 * resolution"). Tokens are high-entropy UUIDs, so this isn't meaningfully
 * defending against guessing — it's throttling repeated automated
 * resolution of one link (e.g. a leaked/scanned URL), which is the actual
 * threat model for this endpoint.
 */
export async function checkInviteLookupRateLimit(token: string): Promise<boolean> {
  return checkRateLimit(
    `invite-lookup:${token}`,
    INVITE_LOOKUP_WINDOW_SECONDS,
    INVITE_LOOKUP_MAX_ATTEMPTS,
  );
}
