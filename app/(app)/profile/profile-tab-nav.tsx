"use client";

import { useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";

// Phase F (Brohda 2.0 redesign, spec §14, §38) — replaces the old
// profile-tabs.tsx's homegrown `useState` + CSS-display-toggle mechanism
// (which also silently overflowed at ~375px, spec §38's own "MUST be
// fixed" bug) with the real Phase B Tabs primitive, the same one
// Discovery's DiscoveryTabNav already uses successfully. Down from six
// items (Predictions / Market Predictions / Teams & Leagues / Edit profile
// / Analytics / Rules) to exactly two real content tabs — "fewer, clearer
// profile surfaces" (spec §14). Edit profile is now a header action (see
// ProfileHeader), not a tab; Analytics/Rules links are removed from
// Profile entirely (spec §17-18).
//
// `?tab=` driven and server-rendered per request (same reasoning as
// DiscoveryTabNav's own comment) — router.refresh() alongside router.push
// forces that fresh render on every tab switch rather than risking a
// stale Client Router Cache hit on a search-param-only navigation (the
// real bug Phase D's own visual verification found and fixed; built in
// here from the start instead of discovered again).
export type ProfileTab = "predictions" | "communities";

const TAB_LABELS: Record<ProfileTab, string> = {
  predictions: "Predictions",
  communities: "Communities",
};

export function ProfileTabNav({ active, basePath }: { active: ProfileTab; basePath: string }) {
  const router = useRouter();

  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        router.push(`${basePath}?tab=${value}`);
        router.refresh();
      }}
    >
      <TabsList>
        {(Object.keys(TAB_LABELS) as ProfileTab[]).map((tab) => (
          <TabsTab key={tab} value={tab}>
            {TAB_LABELS[tab]}
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}
