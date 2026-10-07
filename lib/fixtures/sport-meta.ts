// Display metadata for the sports Events supports — derived from the shared sport registry (lib/sports-data/sport-registry.ts), the one place
// that knows which sports exist, so it stays a lookup keyed by sport, never a hard-coded per-sport branch in a component. A sport appears here
// only when it is `live` in the registry (MLB is declared with no adapter, so it is not listed until it launches). Client-safe: no server imports.
import { SPORT_CONFIGS, liveSportConfigs, type SportKey } from "@/lib/sports-data/sport-registry";
import type { EventSport } from "./local-browse";

export interface SportMeta {
  sport: EventSport;
  label: string;
  shortLabel: string;
  icon: string;
}

// Decoration only (not a rule): an emoji per sport key.
const ICONS: Record<SportKey, string> = { american_football: "🏈", basketball: "🏀", hockey: "🏒", baseball: "⚾" };

const LISTED = liveSportConfigs();

export const SPORT_META = Object.fromEntries(
  SPORT_CONFIGS.map((c) => [c.sport, { sport: c.sport, label: c.label, shortLabel: c.label, icon: ICONS[c.sport] } satisfies SportMeta]),
) as Record<EventSport, SportMeta>;

export const ALL_EVENT_SPORTS: EventSport[] = LISTED.map((c) => c.sport);

export function isEventSport(value: string): value is EventSport {
  return ALL_EVENT_SPORTS.includes(value as EventSport);
}
