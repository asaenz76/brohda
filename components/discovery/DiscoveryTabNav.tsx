"use client";

import { useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";

// Phase D (Brohda 2.0 redesign) — Discovery's exactly-three locked tabs
// (spec §2), URL-driven via `?tab=` so a specific tab is directly
// linkable/shareable/back-button-safe, and each tab's Community list is
// fetched server-side per the URL (no client-side data fetch, no
// pre-fetching all three tabs' data on every load). This component only
// owns the tab BAR's interactive/ARIA behavior (Tabs/TabsList/TabsTab,
// built in Phase B, unused until now) — the actual list content renders
// as a normal server-rendered sibling below it in the page, not inside a
// Tabs.Panel, since there is nothing to client-side swap between (each
// tab change is a real navigation to fresh server-rendered data).
export type DiscoveryTab = "sports" | "leagues" | "teams";

const TAB_LABELS: Record<DiscoveryTab, string> = {
  sports: "Sports",
  leagues: "Leagues",
  teams: "Teams",
};

export function DiscoveryTabNav({ active }: { active: DiscoveryTab }) {
  const router = useRouter();

  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        // A search-param-only navigation can otherwise be served from the
        // Client Router Cache (well-documented Next.js App Router gotcha:
        // https://nextjs.org/docs/app/building-your-application/caching#router-cache)
        // instead of a fresh render of the Community list below (which
        // reads `searchParams.tab` in the Server Component) — router.refresh()
        // forces that refetch against the new URL every time.
        router.push(`/discovery?tab=${value as DiscoveryTab}`);
        router.refresh();
      }}
    >
      <TabsList>
        {(Object.keys(TAB_LABELS) as DiscoveryTab[]).map((tab) => (
          <TabsTab key={tab} value={tab}>
            {TAB_LABELS[tab]}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}
