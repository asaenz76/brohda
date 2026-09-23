import "server-only";
import { checkRateLimit } from "./check";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R9 §67 — mirrors lib/rate-limit/challenges.ts exactly. Window/
// attempt cap are configurable product policy (platform_settings.
// monetary_proposal_rate_limit_*), read live, protecting proposal CREATION
// only — accept/decline/withdraw are inherently self-limiting the same way
// R7 reasoned about accept/decline: a user can only act on a proposal that
// already exists and is already addressed to (or owned by) them.

interface MonetaryProposalRateLimitPolicy {
  windowSeconds: number;
  maxAttempts: number;
}

const DEFAULT_POLICY: MonetaryProposalRateLimitPolicy = { windowSeconds: 60, maxAttempts: 10 };

async function getMonetaryProposalRateLimitPolicy(): Promise<MonetaryProposalRateLimitPolicy> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("platform_settings")
    .select("monetary_proposal_rate_limit_window_seconds, monetary_proposal_rate_limit_max_attempts")
    .eq("id", true)
    .single();
  if (!data) return DEFAULT_POLICY;
  return {
    windowSeconds: data.monetary_proposal_rate_limit_window_seconds ?? DEFAULT_POLICY.windowSeconds,
    maxAttempts: data.monetary_proposal_rate_limit_max_attempts ?? DEFAULT_POLICY.maxAttempts,
  };
}

export async function checkMonetaryProposalRateLimit(userId: string): Promise<boolean> {
  const policy = await getMonetaryProposalRateLimitPolicy();
  return checkRateLimit(`monetary_proposal:${userId}`, policy.windowSeconds, policy.maxAttempts);
}
