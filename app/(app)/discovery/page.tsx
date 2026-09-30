import { Compass } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { listCommunitiesByType } from "@/lib/communities/discovery";
import { DiscoveryTabNav, type DiscoveryTab } from "@/components/discovery/DiscoveryTabNav";
import { DiscoveryRow } from "@/components/discovery/DiscoveryRow";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import type { CommunityType } from "@/lib/communities/types";

/**
 * Phase D (Brohda 2.0 redesign) — Discovery: Brohda's Explore surface,
 * exactly three locked tabs (Sports / Leagues / Teams) into the existing
 * Community graph (spec §2). Not Home, not a Market/Game browser, no
 * fourth tab. `?tab=` drives which list renders — server-fetched per
 * request (only the active tab's Communities are queried, never all
 * three), directly linkable/shareable.
 *
 * Data source is exactly the real, current `communities` table via
 * listCommunitiesByType() (lib/communities/discovery.ts) — no synthetic
 * catalog. See that file's own header and this milestone's Phase D
 * report for the real production gap (32 TEAM / 1 LEAGUE / 1 SPORT
 * Communities today vs. 392 teams / 15 leagues in the underlying sports
 * data) — Communities are only created once a Post has been distributed
 * for that subject (Phase A/lib/communities/distribution.ts), which this
 * phase does not change.
 */
const TAB_TYPE: Record<DiscoveryTab, CommunityType> = { sports: "SPORT", leagues: "LEAGUE", teams: "TEAM" };
const VALID_TABS: DiscoveryTab[] = ["sports", "leagues", "teams"];
const EMPTY_COPY: Record<DiscoveryTab, string> = {
  sports: "No sports to show yet.",
  leagues: "No leagues to show yet.",
  teams: "No teams to show yet.",
};

function parseTab(raw: string | undefined): DiscoveryTab {
  return VALID_TABS.includes(raw as DiscoveryTab) ? (raw as DiscoveryTab) : "sports";
}

export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { tab: tabParam } = await searchParams;
  const tab = parseTab(tabParam);

  const items = await listCommunitiesByType(TAB_TYPE[tab], user.id);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Discovery</h1>
      <DiscoveryTabNav active={tab} />

      {items.length === 0 ? (
        <EmptyFeedState icon={Compass} title={EMPTY_COPY[tab]} description="Check back soon — this grows as Brohda covers more games." />
      ) : (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {items.map((item) => (
            <DiscoveryRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
