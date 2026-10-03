import type { CommunityType } from "@/lib/communities/types";

// The three locked Discovery tabs and how each maps onto the Community
// graph. Shared by the signed-in /discovery page and the logged-out front
// door so both read the same `?tab=` URL contract and the same
// Community type per tab — one definition, not two that can drift.
export type DiscoveryTab = "sports" | "leagues" | "teams";

export const DISCOVERY_TABS: readonly DiscoveryTab[] = ["sports", "leagues", "teams"];

export const DISCOVERY_TAB_LABELS: Record<DiscoveryTab, string> = {
  sports: "Sports",
  leagues: "Leagues",
  teams: "Teams",
};

export const DISCOVERY_TAB_TYPE: Record<DiscoveryTab, CommunityType> = {
  sports: "SPORT",
  leagues: "LEAGUE",
  teams: "TEAM",
};

export const DISCOVERY_EMPTY_COPY: Record<DiscoveryTab, string> = {
  sports: "No sports to show yet.",
  leagues: "No leagues to show yet.",
  teams: "No teams to show yet.",
};

export function parseDiscoveryTab(raw: string | undefined): DiscoveryTab {
  return DISCOVERY_TABS.includes(raw as DiscoveryTab) ? (raw as DiscoveryTab) : "sports";
}
