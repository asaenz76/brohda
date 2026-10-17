import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listGamePreviewCandidates } from "./repository";

/**
 * The scheduled step for Game Previews (it runs inside the existing housekeeping job — no extra scheduler entry): it freezes the pregame Preview of every Game that has started, and reports which upcoming Games still need a Preview
 * (missing or stale, within the configured lead time). It writes no editorial text: research and writing happen outside the request path, through saveGamePreview, never when a Member opens a Post.
 */
export async function runGamePreviewHousekeeping(): Promise<{ frozen: number; missing: number; stale: number }> {
  const { data: frozen, error } = await createAdminClient().rpc("freeze_started_game_previews");
  if (error) throw error;
  const candidates = await listGamePreviewCandidates();
  return { frozen: Number(frozen ?? 0), missing: candidates.filter((c) => c.reason === "MISSING").length, stale: candidates.filter((c) => c.reason === "STALE").length };
}
