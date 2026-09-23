import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CommunityDistributionPolicy } from "./types";

// Milestone R4: fail CLOSED, matching lib/posts/policy.ts and
// lib/prediction-markets/ingestion/policy.ts exactly — this gates a
// write-side action (should the automatic distribution job create
// Communities and distribution rows), so an unreadable settings row must
// never be treated as implicit permission.
const FAIL_CLOSED_POLICY: CommunityDistributionPolicy = { enabled: false, teamEnabled: true, leagueEnabled: true, sportEnabled: true };

export async function getCommunityDistributionPolicy(): Promise<CommunityDistributionPolicy> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("platform_settings")
    .select("community_distribution_enabled, community_team_distribution_enabled, community_league_distribution_enabled, community_sport_distribution_enabled")
    .eq("id", true)
    .single();

  if (!data) return FAIL_CLOSED_POLICY;
  return {
    enabled: data.community_distribution_enabled ?? false,
    teamEnabled: data.community_team_distribution_enabled ?? true,
    leagueEnabled: data.community_league_distribution_enabled ?? true,
    sportEnabled: data.community_sport_distribution_enabled ?? true,
  };
}
