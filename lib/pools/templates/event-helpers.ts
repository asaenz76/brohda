import type { NormalizedFixtureEvent } from "@/lib/sports-data/types";

// fixtures.provider_events_payload stores the already-normalized array a
// provider's getFixtureEvents produced — there's no per-event column to
// extract into the way fixture scores have, so the normalized shape is
// what's cached directly. This just defensively re-validates the jsonb
// value's shape at read time. No currently-registered template requires
// FIXTURE_EVENTS (the football-only ones that did — first team to score,
// red card, penalty awarded, own goal, goal-after-minute, player to score —
// are retired along with Association football), but grade.ts's dispatch on
// PoolTemplate.requiredDataSources stays sport-agnostic, so this stays
// available for a future template that needs it.
export function parseEvents(raw: unknown): NormalizedFixtureEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw as NormalizedFixtureEvent[];
}
