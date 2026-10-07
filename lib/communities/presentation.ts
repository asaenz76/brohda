import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Community, CommunityType } from "./types";

// Stage 4A remediation (Stage 4 audit §12): `communities.type` is internal
// vocabulary ("TEAM"/"LEAGUE"/"SPORT") — never render it verbatim to a
// user. A plain, stable, human-cased label; the underlying enum value
// itself is untouched (DB storage stays exactly as it is).
const COMMUNITY_TYPE_LABELS: Record<CommunityType, string> = {
  TEAM: "Team",
  LEAGUE: "League",
  SPORT: "Sport",
};

export function getCommunityTypeLabel(type: CommunityType): string {
  return COMMUNITY_TYPE_LABELS[type];
}

// Milestone R4 (§6): TEAM/LEAGUE Communities never store their own display
// name (avoids duplicating mutable team/league truth) — presentation is
// always derived live by joining back to the canonical entity. Only SPORT
// carries a stored name, since nothing else can supply one.
export async function getCommunityDisplayName(community: Community): Promise<string> {
  if (community.type === "SPORT") return community.displayName ?? community.sportKey ?? "Sport";

  const admin = createAdminClient();
  if (community.type === "TEAM" && community.teamId) {
    const { data } = await admin.from("teams").select("name").eq("id", community.teamId).maybeSingle();
    return data?.name ?? "Team";
  }
  if (community.type === "LEAGUE" && community.leagueId) {
    const { data } = await admin.from("leagues").select("name").eq("id", community.leagueId).maybeSingle();
    return data?.name ?? "League";
  }
  return "Community";
}

export interface CommunityIdentity {
  displayName: string;
  /** From teams.logo_url / leagues.logo_url — always null for SPORT (no logo concept exists for it; spec §5). Never a hard-coded URL. */
  logoUrl: string | null;
  /** SPORT Communities only: the sport key, for the sport's own icon. */
  sportKey?: string | null;
}

/**
 * Phase E (Brohda 2.0 redesign) — the Community page header's own single-
 * Community identity read (name + logo together, one query, instead of
 * getCommunityDisplayName's name-only). The batched list-sized sibling is
 * lib/communities/discovery.ts's private resolveNamesAndLogos — this
 * function is that same resolution rule for exactly one Community, which a
 * page header never needs batched.
 */
export async function getCommunityIdentity(community: Community): Promise<CommunityIdentity> {
  if (community.type === "SPORT") return { displayName: community.displayName ?? community.sportKey ?? "Sport", logoUrl: null, sportKey: community.sportKey };

  const admin = createAdminClient();
  if (community.type === "TEAM" && community.teamId) {
    const { data } = await admin.from("teams").select("name, logo_url").eq("id", community.teamId).maybeSingle();
    return { displayName: data?.name ?? "Team", logoUrl: data?.logo_url ?? null };
  }
  if (community.type === "LEAGUE" && community.leagueId) {
    const { data } = await admin.from("leagues").select("name, logo_url").eq("id", community.leagueId).maybeSingle();
    return { displayName: data?.name ?? "League", logoUrl: data?.logo_url ?? null };
  }
  return { displayName: "Community", logoUrl: null };
}
