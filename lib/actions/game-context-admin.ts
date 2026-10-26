"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseGameContextConfig } from "@/lib/game-context/config";

export interface GameContextAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

/** Each field is optional: omit it to leave that setting as it is. `config` REPLACES the whole threshold set ({} = back to the defaults). */
export interface GameContextPolicyChange {
  enabled?: boolean;
  config?: Record<string, number | boolean>;
}

/**
 * Super Admin: Game Context's on/off switch and thresholds, through ONE audited, idempotent database function (admin_set_game_context_policy; audit action settings.game_context_policy_updated).
 * Game Context only READS stored sports data, so turning it on or off rewrites nothing; turning it off is the whole rollback.
 */
export async function setGameContextPolicyAction(change: GameContextPolicyChange): Promise<GameContextAdminResult> {
  const admin = await requireSuperAdmin();
  if (change.enabled !== undefined && typeof change.enabled !== "boolean") return { success: false, error: "That setting isn't valid." };
  if (change.config !== undefined) {
    if (typeof change.config !== "object" || change.config === null || Array.isArray(change.config)) return { success: false, error: "Those thresholds aren't valid." };
    // The same parser the feed uses: if it would reject the thresholds, so do we, before the database is asked.
    if (!parseGameContextConfig({ game_context_enabled: true, game_context_config: change.config }).enabled) return { success: false, error: "Those thresholds aren't valid." };
  }

  const { error } = await createAdminClient().rpc("admin_set_game_context_policy", {
    p_admin_id: admin.id,
    p_enabled: change.enabled ?? null,
    p_config: change.config ?? null,
  });
  if (error?.message.includes("invalid_config")) return { success: false, error: "Those thresholds aren't valid." };
  if (error) return { success: false, error: "Couldn't save that setting." };
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/feed");
  return { success: true, error: null, message: "Saved." };
}
