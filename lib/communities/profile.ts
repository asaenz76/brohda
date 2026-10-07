import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listCommunitiesByIds } from "./repository";
import { listFollowedCommunityIds } from "./follows";
import type { Community, CommunityType } from "./types";
import type { CommunityListItem } from "./discovery";

// Phase F (Brohda 2.0 redesign) — a Profile's own "sports affinity"
// surface (spec §15-16): the Sports/Leagues/Teams a PERSON has declared
// they follow, grouped by type, human-labeled. This is a genuinely new
// public use of community_follows: that table's own header comment
// (lib/communities/follows.ts) was written before Phases D/E made
// Discovery/Community pages a public-facing feature at all, and
// explicitly says declared Community affinity was "not implemented" as a
// public "I am a fan" statement. Phase F's own spec explicitly asks for
// exactly this surface, so this supersedes that stance.
//
// Phase G (spec §15 audit) hardened the boundary this created: the
// profile OWNER's follow list — the thing actually being shown to a
// possibly-unrelated viewer — now reads from the new
// public_community_follows view (migration 20260101000170) instead of
// the raw table, the same public_profiles pattern already established
// for bio/pronouns/gender. That view is granted directly to
// `authenticated` (filtered to active accounts), so the "this is public"
// boundary is now an explicit, narrow, database-level contract any future
// consumer can rely on — not just "this one function happens to never
// take an arbitrary filter." Still read via the admin client here (not
// the request-scoped one): this module already runs outside real Next.js
// request scope in integration tests, where the cookie-based client
// cannot be constructed at all, and reading a view through the
// service-role client carries no additional exposure beyond what every
// other lib/communities/* query already has — the hardening this
// migration adds is the view/grant existing in the schema, not which
// already-trusted server-only caller happens to read it.
//
// The VIEWER's own follow state below (`isFollowing`) is a different,
// non-sensitive read (your own rows are already selectable under
// community_follows' normal RLS) and stays on the existing admin-client
// listFollowedCommunityIds — narrowing that too would add nothing.

export interface ProfileCommunityGroup {
  type: CommunityType;
  items: CommunityListItem[];
}

const GROUP_ORDER: CommunityType[] = ["SPORT", "LEAGUE", "TEAM"];

/** Reads the new public_community_follows view (migration 20260101000170) rather than the raw community_follows table — see this file's own header comment for why the admin client is still correct here. */
async function listPublicFollowedCommunityIds(profileUserId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("public_community_follows").select("community_id").eq("user_id", profileUserId);
  if (error) throw error;
  return (data ?? []).map((row) => row.community_id);
}

/** Same batched name/logo resolution rule as lib/communities/discovery.ts's own private resolveNamesAndLogos (2 queries total regardless of list size) — a small, intentional duplication of that established pattern rather than exporting a private helper across file boundaries. */
async function resolveIdentities(communities: Community[]): Promise<Map<string, { displayName: string; logoUrl: string | null }>> {
  const result = new Map<string, { displayName: string; logoUrl: string | null }>();
  const admin = createAdminClient();

  const teamIds = communities.filter((c) => c.type === "TEAM" && c.teamId).map((c) => c.teamId as string);
  const leagueIds = communities.filter((c) => c.type === "LEAGUE" && c.leagueId).map((c) => c.leagueId as string);

  const [teamRows, leagueRows] = await Promise.all([
    teamIds.length > 0 ? admin.from("teams").select("id, name, logo_url").in("id", teamIds) : Promise.resolve({ data: [] }),
    leagueIds.length > 0 ? admin.from("leagues").select("id, name, logo_url").in("id", leagueIds) : Promise.resolve({ data: [] }),
  ]);
  const teamById = new Map((teamRows.data ?? []).map((t: { id: string; name: string; logo_url: string | null }) => [t.id, t]));
  const leagueById = new Map((leagueRows.data ?? []).map((l: { id: string; name: string; logo_url: string | null }) => [l.id, l]));

  for (const community of communities) {
    if (community.type === "SPORT") {
      result.set(community.id, { displayName: community.displayName ?? "Sport", logoUrl: null });
    } else if (community.type === "TEAM" && community.teamId) {
      const team = teamById.get(community.teamId);
      result.set(community.id, { displayName: team?.name ?? "Team", logoUrl: team?.logo_url ?? null });
    } else if (community.type === "LEAGUE" && community.leagueId) {
      const league = leagueById.get(community.leagueId);
      result.set(community.id, { displayName: league?.name ?? "League", logoUrl: league?.logo_url ?? null });
    }
  }
  return result;
}

/**
 * `profileUserId`'s followed Communities, grouped by type (Sports first,
 * then Leagues, then Teams — spec §15's own listed order), alphabetical
 * within each group, empty groups omitted entirely. `isFollowing` on each
 * item reflects `viewerId`'s OWN follow state for that Community (so the
 * viewer can follow a Community they see on someone else's profile,
 * exactly as DiscoveryRow/CommunityFollowButton already behave elsewhere)
 * — never the profile owner's, which is instead what determined the item
 * appearing in this list at all.
 */
export async function listFollowedCommunitiesForProfile(profileUserId: string, viewerId: string | null): Promise<ProfileCommunityGroup[]> {
  const [ownedCommunityIds, viewerFollowedIds] = await Promise.all([
    listPublicFollowedCommunityIds(profileUserId),
    viewerId ? listFollowedCommunityIds(viewerId) : Promise.resolve([]),
  ]);
  if (ownedCommunityIds.length === 0) return [];

  const viewerFollowedSet = new Set(viewerFollowedIds);
  const communities = await listCommunitiesByIds(ownedCommunityIds);
  const identities = await resolveIdentities(communities);

  const items: CommunityListItem[] = communities.map((c) => {
    const identity = identities.get(c.id);
    return {
      id: c.id,
      slug: c.slug,
      type: c.type,
      displayName: identity?.displayName ?? "Community",
      logoUrl: identity?.logoUrl ?? null,
      sportKey: c.type === "SPORT" ? c.sportKey : null,
      isFollowing: viewerFollowedSet.has(c.id),
      mostRecentPostAt: null,
    };
  });

  const byType = new Map<CommunityType, CommunityListItem[]>();
  for (const item of items) {
    const bucket = byType.get(item.type) ?? [];
    bucket.push(item);
    byType.set(item.type, bucket);
  }

  return GROUP_ORDER.map((type) => ({
    type,
    items: (byType.get(type) ?? []).sort((a, b) => a.displayName.localeCompare(b.displayName)),
  })).filter((group) => group.items.length > 0);
}
