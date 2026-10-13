"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export interface SponsorIntelligenceResult {
  success: boolean;
  error: string | null;
  message?: string;
}

// The ranges mirror the database CHECK constraints (migration 196), which are the authority — this only gives a readable message before the round trip.
const configSchema = z.object({
  enabled: z.boolean(),
  minCohort: z.number().int().min(2, "The privacy threshold can't be below 2 — a count of 1 identifies a person.").max(10000),
  lookbackDays: z.number().int().min(1).max(730),
});

/**
 * Super Admin: Sponsor Intelligence on/off, the privacy threshold and the affinity look-back. Policy only — no deploy. The change is audited by the database function
 * (settings.sponsor_intelligence_updated). Turning it OFF immediately removes Sponsors' access; internal measurement and Super Admin views are unaffected.
 */
export async function setSponsorIntelligenceConfigAction(_prev: SponsorIntelligenceResult | null, formData: FormData): Promise<SponsorIntelligenceResult> {
  const admin = await requireSuperAdmin();
  const parsed = configSchema.safeParse({
    enabled: formData.get("enabled") === "on",
    minCohort: Number(formData.get("minCohort")),
    lookbackDays: Number(formData.get("lookbackDays")),
  });
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values and try again." };
  const { error } = await createAdminClient().rpc("admin_set_sponsor_intelligence_config", {
    p_admin_id: admin.id,
    p_enabled: parsed.data.enabled,
    p_min_cohort: parsed.data.minCohort,
    p_lookback_days: parsed.data.lookbackDays,
  });
  if (error) return { success: false, error: "Couldn't save the Sponsor Intelligence settings." };
  revalidatePath("/admin/settings/brohda"); // where the control lives (Settings → Brohda → Sponsorship)
  revalidatePath("/admin/sponsorship");
  revalidatePath("/sponsor");
  return { success: true, error: null, message: parsed.data.enabled ? "Sponsor Intelligence is on." : "Sponsor Intelligence is off." };
}
