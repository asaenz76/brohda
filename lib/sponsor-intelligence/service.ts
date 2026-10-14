import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSportLabel } from "@/lib/sports-data/sport-registry";
import { getSponsorshipForAdmin, getSponsorshipForUser } from "@/lib/sponsorship/repository";
import { buildAdminReport, buildSponsorReport, type AdminReport, type RawAggregates, type SponsorReport } from "./report";

// The one place Sponsor Intelligence is read. Three rules live here and nowhere else:
//   1. The capability FAILS CLOSED: only a successfully read, literal `true` is ON. A missing row, a malformed value or an unreadable setting is OFF.
//   2. A Sponsor sees a campaign's results only if that campaign belongs to their own Sponsor organization (the same ownership check the Sponsor's sponsorship page already uses),
//      and only through the suppressed view. There is no Member-level read anywhere: the database function returns counts and labels only.
//   3. The threshold and look-back come from platform_settings, never from code.

export interface SponsorIntelligenceConfig {
  enabled: boolean;
  minCohort: number;
  affinityLookbackDays: number;
}

/** The capability and policy. `enabled` is false on ANY read problem; the numeric values are only meaningful when it is true. */
export async function getSponsorIntelligenceConfig(): Promise<SponsorIntelligenceConfig> {
  const closed: SponsorIntelligenceConfig = { enabled: false, minCohort: Number.POSITIVE_INFINITY, affinityLookbackDays: 0 };
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("platform_settings")
      .select("sponsor_intelligence_enabled, sponsor_intelligence_min_cohort, sponsor_intelligence_affinity_lookback_days")
      .eq("id", true)
      .single();
    if (error || !data) return closed;
    const minCohort = data.sponsor_intelligence_min_cohort;
    const lookback = data.sponsor_intelligence_affinity_lookback_days;
    if (data.sponsor_intelligence_enabled !== true || !Number.isInteger(minCohort) || minCohort < 2 || !Number.isInteger(lookback) || lookback < 1) return closed;
    return { enabled: true, minCohort, affinityLookbackDays: lookback };
  } catch {
    return closed;
  }
}

export async function isSponsorIntelligenceEnabled(): Promise<boolean> {
  return (await getSponsorIntelligenceConfig()).enabled;
}

/** Settings as Super Admin sees them (the values even while the capability is OFF). Throws if they cannot be read — nothing is invented. */
export async function getSponsorIntelligencePolicy(): Promise<SponsorIntelligenceConfig> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("platform_settings")
    .select("sponsor_intelligence_enabled, sponsor_intelligence_min_cohort, sponsor_intelligence_affinity_lookback_days")
    .eq("id", true)
    .single();
  if (error || !data) throw new Error("Could not read the Sponsor Intelligence settings.");
  return { enabled: data.sponsor_intelligence_enabled === true, minCohort: data.sponsor_intelligence_min_cohort, affinityLookbackDays: data.sponsor_intelligence_affinity_lookback_days };
}

async function loadExactAggregates(sponsorshipId: string, affinityLookbackDays: number): Promise<RawAggregates | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("sponsor_intelligence_aggregates", { p_sponsorship_id: sponsorshipId, p_lookback_days: affinityLookbackDays });
  if (error) throw new Error(error.message);
  return (data as RawAggregates | null) ?? null;
}

const sportLabel = (key: string): string => getSportLabel(key) ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export type SponsorCampaignResults =
  | { state: "off" } // capability is OFF — the Sponsor is shown nothing, not even a hint that it exists
  | { state: "not_found" } // not this Sponsor's campaign (indistinguishable from a missing one)
  | { state: "not_started" } // the campaign has not begun presenting yet
  | { state: "ready"; report: SponsorReport };

/** What a Sponsor may see about one of THEIR OWN campaigns. Suppressed, aggregate-only, and absent entirely while the capability is OFF. */
export async function getSponsorCampaignResults(userId: string, sponsorshipId: string): Promise<SponsorCampaignResults> {
  const config = await getSponsorIntelligenceConfig();
  if (!config.enabled) return { state: "off" };
  const sponsorship = await getSponsorshipForUser(userId, sponsorshipId);
  if (!sponsorship) return { state: "not_found" };
  const raw = await loadExactAggregates(sponsorshipId, config.affinityLookbackDays);
  if (!raw) return { state: "not_found" };
  if (!raw.started) return { state: "not_started" };
  return { state: "ready", report: buildSponsorReport(raw, config.minCohort, sportLabel) };
}

export type AdminCampaignResults = { state: "not_found" } | { state: "ready"; capabilityEnabled: boolean; policy: SponsorIntelligenceConfig; report: AdminReport };

/** Super Admin's exact view of one campaign, plus what the Sponsor currently would (or would not) be shown. Works whether or not the capability is ON — it is operational. */
export async function getAdminCampaignResults(sponsorshipId: string): Promise<AdminCampaignResults> {
  const sponsorship = await getSponsorshipForAdmin(sponsorshipId);
  if (!sponsorship) return { state: "not_found" };
  const policy = await getSponsorIntelligencePolicy();
  const raw = await loadExactAggregates(sponsorshipId, policy.affinityLookbackDays);
  if (!raw) return { state: "not_found" };
  return { state: "ready", capabilityEnabled: policy.enabled, policy, report: buildAdminReport(raw, policy.minCohort, sportLabel) };
}
