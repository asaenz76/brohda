// Display metadata for the sports Events currently supports — a lookup
// table keyed by sport, not a hardcoded per-sport branch scattered through
// components, so it stays structurally capable of accommodating another
// sport later without redesigning the page. Adding a sport means adding
// one entry here (plus real provider support, which this file has nothing
// to do with) — it does not mean this file predicts what that sport's
// entry will look like. Brohda's long-term supported-sports direction is
// NFL, NBA, NHL, and MLB; only NFL is actually implemented today; the
// other three are deliberately absent from this registry (not stubbed)
// until they're real.
import type { EventSport } from "./local-browse";

export interface SportMeta {
  sport: EventSport;
  label: string;
  shortLabel: string;
  icon: string;
}

export const SPORT_META: Record<EventSport, SportMeta> = {
  american_football: { sport: "american_football", label: "NFL", shortLabel: "NFL", icon: "🏈" },
};

export const ALL_EVENT_SPORTS: EventSport[] = ["american_football"];

export function isEventSport(value: string): value is EventSport {
  return value === "american_football";
}
