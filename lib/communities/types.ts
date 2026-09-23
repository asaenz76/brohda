// Milestone R4 (docs/BROHDA_2_0_MILESTONE_MAP.md, Community + Distribution).
// A Community is an affinity/distribution object — it answers "which
// sports audience is this Post relevant to?" It never owns a Post, never
// duplicates Post/Market/Pick state, and is never a generic discussion
// group. See docs/architecture/community-distribution.md for the full
// domain rationale.

export type CommunityType = "TEAM" | "LEAGUE" | "SPORT";

export interface Community {
  id: string;
  type: CommunityType;
  teamId: string | null;
  leagueId: string | null;
  sportKey: string | null;
  slug: string;
  /** Only ever non-null for type SPORT — see communities.display_name's own column comment. */
  displayName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityDistributionPolicy {
  enabled: boolean;
  teamEnabled: boolean;
  leagueEnabled: boolean;
  sportEnabled: boolean;
}
