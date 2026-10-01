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
// exactly this surface, so this supersedes that stance — flagged in the
// Phase F report's Privacy section rather than silently added. RLS on
// community_follows still restricts direct client reads to the owning
// row (`user_id = auth.uid()`); this reads via the service-role admin
// client, the same privilege level every other lib/communities/* query
// already uses — no new capability, only a new consumer of it.

export interface ProfileCommunityGroup {
  type: CommunityType;
  items: CommunityListItem[];
}

const GROUP_ORDER: CommunityType[] = ["SPORT", "LEAGUE", "TEAM"];

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
    listFollowedCommunityIds(profileUserId),
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
