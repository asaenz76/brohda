"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export interface LeaderboardAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

/** Each field is optional: omit it to leave that setting as it is. */
export interface LeaderboardPolicyChange {
  enabled?: boolean;
  weeklyMinDecidedPicks?: number;
  topN?: number;
}

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/**
 * Super Admin: the weekly leaderboard's on/off switch, its qualification minimum and how many Members it lists, through ONE audited, idempotent database function (admin_set_leaderboard_policy; audit action
 * settings.leaderboard_policy_updated). The leaderboard only READS stored Picks, so turning it on or off rewrites nothing; turning it off is the whole rollback. A Super Admin sets the policy, never a Member's rank.
 */
export async function setLeaderboardPolicyAction(change: LeaderboardPolicyChange): Promise<LeaderboardAdminResult> {
  const admin = await requireSuperAdmin();
  if (change.enabled !== undefined && typeof change.enabled !== "boolean") return { success: false, error: "That setting isn't valid." };
  if (change.weeklyMinDecidedPicks !== undefined && !isInt(change.weeklyMinDecidedPicks, 1, 50)) return { success: false, error: "The minimum must be a whole number from 1 to 50." };
  if (change.topN !== undefined && !isInt(change.topN, 3, 100)) return { success: false, error: "The list size must be a whole number from 3 to 100." };

  const { error } = await createAdminClient().rpc("admin_set_leaderboard_policy", {
    p_admin_id: admin.id,
    p_enabled: change.enabled ?? null,
    p_weekly_min: change.weeklyMinDecidedPicks ?? null,
    p_top_n: change.topN ?? null,
  });
  if (error?.message.includes("invalid_policy")) return { success: false, error: "Those values aren't valid." };
  if (error) return { success: false, error: "Couldn't save that setting." };
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/leaderboard");
  return { success: true, error: null, message: "Saved." };
}
