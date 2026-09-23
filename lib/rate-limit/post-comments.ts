import "server-only";
import { checkRateLimit } from "./check";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Conversation).
// Same generic checkRateLimit primitive lib/rate-limit/comments.ts already
// uses for pool comments — but, deliberately unlike that module, the
// window/attempt cap are configurable product policy
// (platform_settings.post_comment_rate_limit_*), not hard-coded constants.
// Not retrofitted onto the legacy pool-comment limiter; only done this way
// for the new domain, per this milestone's own explicit instruction.

interface PostCommentRateLimitPolicy {
  windowSeconds: number;
  maxAttempts: number;
}

const DEFAULT_POLICY: PostCommentRateLimitPolicy = { windowSeconds: 60, maxAttempts: 10 };

async function getPostCommentRateLimitPolicy(): Promise<PostCommentRateLimitPolicy> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("post_comment_rate_limit_window_seconds, post_comment_rate_limit_max_attempts").eq("id", true).single();
  if (!data) return DEFAULT_POLICY;
  return {
    windowSeconds: data.post_comment_rate_limit_window_seconds ?? DEFAULT_POLICY.windowSeconds,
    maxAttempts: data.post_comment_rate_limit_max_attempts ?? DEFAULT_POLICY.maxAttempts,
  };
}

export async function checkPostCommentRateLimit(userId: string): Promise<boolean> {
  const policy = await getPostCommentRateLimitPolicy();
  return checkRateLimit(`post_comment:${userId}`, policy.windowSeconds, policy.maxAttempts);
}
