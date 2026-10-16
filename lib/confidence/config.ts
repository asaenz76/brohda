import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidStakeLadder } from "./format";

// The one place Confidence policy is read. Every value comes from platform_settings (migration 201) — nothing is a constant in code — and the capability FAILS CLOSED: only a successfully read, literal `true`
// is ON; a missing row, a malformed value or an unreadable setting is OFF.

export interface ConfidenceConfig {
  enabled: true;
  /** New Confidence-backed Picks may be made. (Turning this off never strands an existing reserved stake: those still settle.) */
  backedPicksEnabled: boolean;
  baseline: number;
  dailyClaimAmount: number;
  dailyClaimIntervalHours: number;
  allowedStakes: number[];
}

const COLUMNS =
  "confidence_enabled, confidence_backed_picks_enabled, confidence_mandatory_since, confidence_baseline, confidence_daily_claim_amount, confidence_daily_claim_interval_hours, confidence_allowed_stakes, confidence_notify_correct, confidence_notify_incorrect, confidence_notify_void";
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
      backedPicksEnabled: data.confidence_backed_picks_enabled === true,
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
  backedPicksEnabled: boolean;
  /** When "every Pick needs Confidence" was enforced in the database (ISO), or null while it is not. */
  mandatorySince: string | null;
  notifyCorrect: string;
  notifyIncorrect: string;
  notifyVoid: string;
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
    backedPicksEnabled: data.confidence_backed_picks_enabled === true,
    mandatorySince: data.confidence_mandatory_since ?? null,
    notifyCorrect: data.confidence_notify_correct,
    notifyIncorrect: data.confidence_notify_incorrect,
    notifyVoid: data.confidence_notify_void,
    baseline: data.confidence_baseline,
    dailyClaimAmount: data.confidence_daily_claim_amount,
    dailyClaimIntervalHours: data.confidence_daily_claim_interval_hours,
    allowedStakes: data.confidence_allowed_stakes,
  };
}

/** The wording appended to a Confidence-backed Pick's graded notification, from settings. Falls back to the built-in sentences if unreadable — a copy problem never withholds the notification. */
export const DEFAULT_SETTLEMENT_COPY = { correct: "+{{amount}}🔥 Confidence.", incorrect: "−{{amount}}🔥 Confidence.", void: "Your {{amount}} Confidence was returned." } as const;

export async function getConfidenceSettlementCopy(): Promise<{ correct: string; incorrect: string; void: string }> {
  try {
    const { data, error } = await createAdminClient().from("platform_settings").select("confidence_notify_correct, confidence_notify_incorrect, confidence_notify_void").eq("id", true).single();
    if (error || !data) return { ...DEFAULT_SETTLEMENT_COPY };
    const ok = [data.confidence_notify_correct, data.confidence_notify_incorrect, data.confidence_notify_void].every((v) => typeof v === "string" && v.length > 0);
    return ok ? { correct: data.confidence_notify_correct, incorrect: data.confidence_notify_incorrect, void: data.confidence_notify_void } : { ...DEFAULT_SETTLEMENT_COPY };
  } catch {
    return { ...DEFAULT_SETTLEMENT_COPY };
  }
}

/** The sentence for a settled stake: the configured template for the result with {{amount}} replaced (plain literal substitution, never evaluated). */
export function renderSettlementSentence(result: "CORRECT" | "INCORRECT" | "VOID", amount: number, copy: { correct: string; incorrect: string; void: string }): string {
  const template = result === "CORRECT" ? copy.correct : result === "INCORRECT" ? copy.incorrect : copy.void;
  return template.replaceAll("{{amount}}", String(amount));
}
