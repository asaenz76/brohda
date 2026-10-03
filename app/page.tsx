import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { getPublicFrontDoorFeed } from "@/lib/landing/public-feed";
import { listCommunitiesByType } from "@/lib/communities/discovery";
import { DISCOVERY_TAB_TYPE, parseDiscoveryTab } from "@/lib/communities/discovery-tabs";
import { PublicFrontDoor } from "@/components/landing/PublicFrontDoor";

export const metadata: Metadata = {
  title: "brohda. — Sports opinions should have a record",
  description: "A social network for people who think they know sports. Pick a side, join the conversation, call BS, and see who was right.",
};

// The logged-out front door: the public face of the same social network a
// member sees on /feed. Signed-in visitors are sent straight into the app, as
// before. With self-service registration closed (invite-only mode) a public
// door nobody outside the invite list can walk through would only advertise
// something they can't use, so "/" falls back to its original behavior —
// straight to /login — exactly as it did.
//
// `?tab=` is Discovery's own contract (Sports | Leagues | Teams). Only the
// active tab's data is read: Sports shows the Game Post feed, Leagues and
// Teams show the real Community lists Discovery already serves.
export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/feed");

  const registrationEnabled = await getRegistrationEnabled();
  if (!registrationEnabled) redirect("/login");

  const { tab: tabParam } = await searchParams;
  const tab = parseDiscoveryTab(tabParam);

  const [feed, communities] = await Promise.all([
    tab === "sports" ? getPublicFrontDoorFeed() : Promise.resolve([]),
    tab === "sports" ? Promise.resolve([]) : listCommunitiesByType(DISCOVERY_TAB_TYPE[tab], null),
  ]);

  return <PublicFrontDoor tab={tab} feed={feed} communities={communities} />;
}
