import { Compass } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { listCommunitiesByType } from "@/lib/communities/discovery";
import { DiscoveryTabNav } from "@/components/discovery/DiscoveryTabNav";
import { DISCOVERY_EMPTY_COPY, DISCOVERY_TAB_TYPE, parseDiscoveryTab } from "@/lib/communities/discovery-tabs";
import { DiscoveryRow } from "@/components/discovery/DiscoveryRow";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

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
export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireSocialPredictionAccess();
  const { tab: tabParam } = await searchParams;
  const tab = parseDiscoveryTab(tabParam);

  const items = await listCommunitiesByType(DISCOVERY_TAB_TYPE[tab], user.id);

  return (
    <div className="space-y-3">
      <ColumnHeader title="Discovery" icon={Compass}>
        <DiscoveryTabNav active={tab} />
      </ColumnHeader>

      {items.length === 0 ? (
        <EmptyFeedState icon={Compass} title={DISCOVERY_EMPTY_COPY[tab]} description="Check back soon — this grows as Brohda covers more games." />
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
