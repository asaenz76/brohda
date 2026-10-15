import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidStakeLadder } from "./format";

// The one place Confidence policy is read. Every value comes from platform_settings (migration 201) — nothing is a constant in code — and the capability FAILS CLOSED: only a successfully read, literal `true`
// is ON; a missing row, a malformed value or an unreadable setting is OFF.

export interface ConfidenceConfig {
  enabled: true;
  baseline: number;
  dailyClaimAmount: number;
  dailyClaimIntervalHours: number;
  allowedStakes: number[];
}

const COLUMNS = "confidence_enabled, confidence_baseline, confidence_daily_claim_amount, confidence_daily_claim_interval_hours, confidence_allowed_stakes";
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;

/** The validated policy, or null when the capability is OFF or any value is unreadable/malformed — callers treat null as OFF. */
export const getConfidenceConfig = cache(async (): Promise<ConfidenceConfig | null> => {
  try {
    const { data, error } = await createAdminClient().from("platform_settings").select(COLUMNS).eq("id", true).single();
    if (error || !data || data.confidence_enabled !== true) return null;
    if (!isPositiveInt(data.confidence_baseline) || !isPositiveInt(data.confidence_daily_claim_amount) || !isPositiveInt(data.confidence_daily_claim_interval_hours)) return null;
    if (data.confidence_daily_claim_amount > data.confidence_baseline || !isValidStakeLadder(data.confidence_allowed_stakes)) return null;
    return {
      enabled: true,
      baseline: data.confidence_baseline,
      dailyClaimAmount: data.confidence_daily_claim_amount,
      dailyClaimIntervalHours: data.confidence_daily_claim_interval_hours,
      allowedStakes: data.confidence_allowed_stakes,
    };
  } catch {
    return null;
  }
});

/** A cheap single-boolean check for places that only need to know whether to show anything. Fails closed. */
export const isConfidenceEnabled = cache(async (): Promise<boolean> => {
  try {
    const { data, error } = await createAdminClient().from("platform_settings").select("confidence_enabled").eq("id", true).single();
    return !error && data?.confidence_enabled === true;
  } catch {
    return false;
  }
});

export interface ConfidenceSettingsForAdmin {
  enabled: boolean;
  baseline: number;
  dailyClaimAmount: number;
  dailyClaimIntervalHours: number;
  allowedStakes: number[];
}

/** The raw settings for the Super Admin card, even while the capability is OFF. Throws if unreadable — nothing is invented. */
export async function getConfidenceSettingsForAdmin(): Promise<ConfidenceSettingsForAdmin> {
  const { data, error } = await createAdminClient().from("platform_settings").select(COLUMNS).eq("id", true).single();
  if (error || !data) throw new Error("Could not read the Confidence settings.");
  return {
    enabled: data.confidence_enabled === true,
    baseline: data.confidence_baseline,
    dailyClaimAmount: data.confidence_daily_claim_amount,
    dailyClaimIntervalHours: data.confidence_daily_claim_interval_hours,
    allowedStakes: data.confidence_allowed_stakes,
  };
}
