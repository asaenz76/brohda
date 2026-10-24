"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARKET_TEMPLATES } from "@/lib/prediction-markets/market-policy-parse";

export interface MarketPolicyAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

/** Each field is optional: omit it to leave that setting as it is. */
export interface MarketPolicyChange {
  fixtureMarketsEnabled?: boolean;
  requirePrice?: boolean;
  allowedTemplates?: string[];
  ingestionTemplates?: string[];
}

const isTemplateList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string" && (MARKET_TEMPLATES as readonly string[]).includes(v));

/**
 * Super Admin: the four Brohda 2.1 M2 Market/Pick policy settings, through ONE audited, idempotent, partial-update database function (admin_set_market_policy; audit action
 * settings.market_policy_updated). Nothing is rewritten: Picks, Markets and history are untouched; only what Members are offered and what ingestion writes changes. Rolling back is
 * the same call with the previous values.
 */
export async function setMarketPolicyAction(change: MarketPolicyChange): Promise<MarketPolicyAdminResult> {
  const admin = await requireSuperAdmin();
  if (change.fixtureMarketsEnabled !== undefined && typeof change.fixtureMarketsEnabled !== "boolean") return { success: false, error: "That setting isn't valid." };
  if (change.requirePrice !== undefined && typeof change.requirePrice !== "boolean") return { success: false, error: "That setting isn't valid." };
  if (change.allowedTemplates !== undefined && !isTemplateList(change.allowedTemplates)) return { success: false, error: "Those aren't valid Market types." };
  if (change.ingestionTemplates !== undefined && !isTemplateList(change.ingestionTemplates)) return { success: false, error: "Those aren't valid Market types." };

  const { error } = await createAdminClient().rpc("admin_set_market_policy", {
    p_admin_id: admin.id,
    p_fixture_markets_enabled: change.fixtureMarketsEnabled ?? null,
    p_require_price: change.requirePrice ?? null,
    p_allowed_templates: change.allowedTemplates ?? null,
    p_ingestion_templates: change.ingestionTemplates ?? null,
  });
  if (error?.message.includes("invalid_templates")) return { success: false, error: "Those aren't valid Market types." };
  if (error) return { success: false, error: "Couldn't save that setting." };
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/");
  return { success: true, error: null, message: "Saved." };
}
