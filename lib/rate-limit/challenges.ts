import "server-only";
import { checkRateLimit } from "./check";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges),
// §49. Reuses the same generic checkRateLimit primitive lib/rate-limit/
// post-comments.ts already established this pattern for — window/attempt
// cap are configurable product policy (platform_settings.call_bs_rate_
// limit_*), read live, protecting Challenge CREATION only (§49's own
// "smallest effective protection" — accept/decline are inherently
// self-limiting: a user can only accept/decline a Challenge that already
// exists and is already addressed to them).

interface CallBsRateLimitPolicy {
  windowSeconds: number;
  maxAttempts: number;
}

const DEFAULT_POLICY: CallBsRateLimitPolicy = { windowSeconds: 60, maxAttempts: 10 };

async function getCallBsRateLimitPolicy(): Promise<CallBsRateLimitPolicy> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("call_bs_rate_limit_window_seconds, call_bs_rate_limit_max_attempts").eq("id", true).single();
  if (!data) return DEFAULT_POLICY;
  return {
    windowSeconds: data.call_bs_rate_limit_window_seconds ?? DEFAULT_POLICY.windowSeconds,
    maxAttempts: data.call_bs_rate_limit_max_attempts ?? DEFAULT_POLICY.maxAttempts,
  };
}

export async function checkCallBsRateLimit(userId: string): Promise<boolean> {
  const policy = await getCallBsRateLimitPolicy();
  return checkRateLimit(`call_bs:${userId}`, policy.windowSeconds, policy.maxAttempts);
}
