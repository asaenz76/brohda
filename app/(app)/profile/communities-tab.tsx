import { Compass } from "lucide-react";
import { listFollowedCommunitiesForProfile } from "@/lib/communities/profile";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";
import { DiscoveryRow } from "@/components/discovery/DiscoveryRow";
import { EmptyFeedState } from "@/components/EmptyFeedState";

/**
 * Phase F (Brohda 2.0 redesign, spec §15-16) — a Profile's sports
 * affinity: the Sports/Leagues/Teams `profileUserId` follows, grouped by
 * type with human labels, never a raw enum, never a giant catalog (every
 * group is exactly what that person has actually followed — nothing
 * pre-seeded or invented). Reuses Discovery's own DiscoveryRow as-is (spec
 * §16's own "repurpose... use human labels" direction, and §27's general
 * "reuse sound data/components" posture) — each row's Follow button
 * reflects the CURRENT VIEWER's own follow state, not the profile owner's
 * (see lib/communities/profile.ts's own comment for why that's correct).
 */
export async function CommunitiesTab({ profileUserId, viewerId }: { profileUserId: string; viewerId: string | null }) {
  const groups = await listFollowedCommunitiesForProfile(profileUserId, viewerId);

  if (groups.length === 0) {
    return <EmptyFeedState icon={Compass} title="No Communities followed yet." description="Follow a Sport, League, or Team from Discovery to see it here." />;
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.type} className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{getCommunityTypeLabel(group.type)}</p>
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
            {group.items.map((item) => (
              <DiscoveryRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
