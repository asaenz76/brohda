import "server-only";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, type UserProfile } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";

/**
 * Milestone R13.10, Stage 0 — DEPLOY != ACTIVATE. `social_prediction_
 * enabled` (20260101000167) is deliberately separate from market_
 * ingestion_enabled/post_publication_enabled/community_distribution_
 * enabled: those three gate backend content preparation, this one gates
 * ordinary-user access to the resulting experience. Fail-closed, matching
 * every other platform_settings policy reader in this codebase (lib/
 * posts/policy.ts, lib/prediction-markets/ingestion/policy.ts,
 * lib/communities/policy.ts) — an unreadable settings row must never be
 * treated as implicit access.
 */
export async function getSocialPredictionAccessPolicy(): Promise<{ enabled: boolean }> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("social_prediction_enabled").eq("id", true).single();
  if (!data) return { enabled: false };
  return { enabled: data.social_prediction_enabled ?? false };
}

/**
 * Page-level gate for every Brohda 2.0 social-product route (/markets,
 * /markets/[id], /post/[id], /community/[slug], /leaderboard/predictions,
 * /my-picks) — mirrors requireUser()/requireSuperAdmin()'s own shape
 * exactly (lib/auth/session.ts). Super Admin/Admin always pass, for
 * operational preview and QA, regardless of the flag — the same
 * precedent requireAdminOrAbove() already establishes for admin-adjacent
 * pages. An ordinary player is redirected to /feed (the legacy product's
 * own home, not a dead end) rather than shown a broken/empty page.
 *
 * Enforced server-side, at the page's own Server Component — not by
 * hiding navigation — so direct URL access respects the policy exactly
 * like every other requireX() guard in this codebase.
 */
export async function requireSocialPredictionAccess(): Promise<UserProfile> {
  const user = await requireUser();
  if (isAdminOrAbove(user)) return user;

  const policy = await getSocialPredictionAccessPolicy();
  if (!policy.enabled) {
    redirect("/feed");
  }
  return user;
}
