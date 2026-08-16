// URL-friendly aliasing for EventSport — "american_football" is the raw DB
// value (matches fixtures.sport), but "nfl" is what an admin actually
// types/reads in a shared link. Kept separate from sport-meta.ts (display
// labels) since this is specifically about the ?sport= query param shape.
import { ALL_EVENT_SPORTS, isEventSport } from "@/lib/fixtures/sport-meta";
import type { EventSport } from "@/lib/fixtures/local-browse";

const SPORT_PARAM_ALIASES: Record<string, EventSport> = {
  football: "football",
  soccer: "football",
  nfl: "american_football",
  american_football: "american_football",
};

const SPORT_TO_PARAM: Record<EventSport, string> = {
  football: "football",
  american_football: "nfl",
};

/** `sport=football,nfl` (or omitted) -> the sports to show. Never throws —
 * an unrecognized token is dropped rather than treated as an error, so a
 * malformed/stale link degrades to "show every known sport" instead of a
 * broken page. */
export function parseSportParam(raw: string | undefined): EventSport[] {
  if (!raw) return [...ALL_EVENT_SPORTS];
  const tokens = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const sports = new Set<EventSport>();
  for (const token of tokens) {
    const alias = SPORT_PARAM_ALIASES[token];
    if (alias) sports.add(alias);
    else if (isEventSport(token)) sports.add(token);
  }
  return sports.size > 0 ? [...sports] : [...ALL_EVENT_SPORTS];
}

export function serializeSportParam(sports: EventSport[]): string {
  return sports.map((s) => SPORT_TO_PARAM[s]).join(",");
}
