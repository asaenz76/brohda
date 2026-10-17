"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/messaging/share";

export interface GamePreviewAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

const fail = (error: string): GamePreviewAdminResult => ({ success: false, error });

const FIELDS = [
  ["max_chars", "Preview length (characters)", 100, 2000],
  ["hook_max_chars", "Hook length (characters)", 20, 300],
  ["lead_hours", "Prepare a Game this many hours before kickoff", 1, 720],
  ["stale_after_hours", "A Preview is stale after this many hours without a check", 1, 720],
  ["min_refresh_interval_hours", "Minimum hours between refreshes for a new story", 0, 720],
] as const;

/** Super Admin: the Game Preview limits and timings in one audited call. Validated as a whole; nothing is partially applied. */
export async function setGamePreviewConfigAction(_prev: GamePreviewAdminResult | null, formData: FormData): Promise<GamePreviewAdminResult> {
  const admin = await requireSuperAdmin();
  const config: Record<string, number> = {};
  for (const [key, label, min, max] of FIELDS) {
    const raw = String(formData.get(key) ?? "").trim();
    const value = raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return fail(`${label} must be a whole number from ${min} to ${max}.`);
    config[key] = value;
  }
  const { error } = await createAdminClient().rpc("admin_set_game_preview_config", { p_admin_id: admin.id, p_config: config });
  if (error) return fail("Couldn't save the Game Preview settings.");
  revalidatePath("/admin/game-previews");
  return { success: true, error: null, message: "Saved." };
}

/** Super Admin: take a Preview that turned out to be wrong off the Post. A reason is required and the action is audited; the text and its sources stay on record. */
export async function withdrawGamePreviewAction(_prev: GamePreviewAdminResult | null, formData: FormData): Promise<GamePreviewAdminResult> {
  const admin = await requireSuperAdmin();
  const fixtureId = String(formData.get("fixture_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(fixtureId)) return fail("That Game wasn't found.");
  if (reason.length < 3 || reason.length > 500) return fail("Say why it is being withdrawn (3 to 500 characters).");
  const { data, error } = await createAdminClient().rpc("admin_withdraw_game_preview", { p_admin_id: admin.id, p_fixture_id: fixtureId, p_reason: reason });
  if (error) return fail("Couldn't withdraw the Preview.");
  if ((data as { outcome?: string } | null)?.outcome !== "withdrawn") return fail("That Game has no Preview.");
  revalidatePath("/admin/game-previews");
  revalidatePath("/feed");
  return { success: true, error: null, message: "Withdrawn. The Post no longer shows it." };
}
