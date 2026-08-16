// Display metadata for the sports Events currently supports — Phase 4
// spec §4/§35: "structurally capable of accommodating more sports later
// without redesigning the page" means a lookup table keyed by sport, not
// a hardcoded football/NFL branch scattered through components. Adding a
// third sport later means adding one entry here (plus real provider
// support, which this file has nothing to do with) — it does not mean
// this file predicts what that sport's entry will look like.
import type { EventSport } from "./local-browse";

export interface SportMeta {
  sport: EventSport;
  label: string;
  shortLabel: string;
  icon: string;
}

export const SPORT_META: Record<EventSport, SportMeta> = {
  football: { sport: "football", label: "Football", shortLabel: "FB", icon: "⚽" },
  american_football: { sport: "american_football", label: "NFL", shortLabel: "NFL", icon: "🏈" },
};

export const ALL_EVENT_SPORTS: EventSport[] = ["football", "american_football"];

export function isEventSport(value: string): value is EventSport {
  return value === "football" || value === "american_football";
}
