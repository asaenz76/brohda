import type { NormalizedFixtureEvent } from "@/lib/sports-data/types";

// fixtures.provider_events_payload stores the ALREADY-NORMALIZED array
// (lib/sports-data/api-football-provider.ts's getFixtureEvents output),
// not the raw API-Football response — there's no per-event column to
// extract into the way fixture scores have, so the normalized shape is
// what's cached directly. This just defensively re-validates the jsonb
// value's shape at read time.
export function parseEvents(raw: unknown): NormalizedFixtureEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw as NormalizedFixtureEvent[];
}

// 120 = 90 regulation + up to ~30 min extra time/stoppage — anything past
// that is a penalty shootout, which API-Football represents as further
// "Penalty" goal events with no reliable elapsed-time reset. This is a
// best-effort heuristic (see docs/ARCHITECTURE.md's Phase 2 section) —
// validate against real captured event payloads before fully trusting it.
const SHOOTOUT_MINUTE_THRESHOLD = 120;

function isShootout(event: NormalizedFixtureEvent): boolean {
  return event.effectiveMinute > SHOOTOUT_MINUTE_THRESHOLD;
}

// A goal is treated as VAR-cancelled if any VAR event exists for the same
// team within the same minute — API-Football doesn't reliably expose a
// dedicated "cancelled" flag on the goal event itself, so this pairing is
// the best-effort signal available. Same caveat as isShootout.
function isVarCancelled(event: NormalizedFixtureEvent, allEvents: NormalizedFixtureEvent[]): boolean {
  return allEvents.some(
    (e) => e.type === "VAR" && e.teamExternalId === event.teamExternalId && e.effectiveMinute === event.effectiveMinute,
  );
}

// Goals that actually count toward "did a team/player score" — normal,
// own, or scored-penalty goals; excludes shootout and VAR-cancelled.
export function validGoals(events: NormalizedFixtureEvent[]): NormalizedFixtureEvent[] {
  return events.filter(
    (e) =>
      e.type === "GOAL" &&
      (e.detail === "GOAL_NORMAL" || e.detail === "GOAL_OWN" || e.detail === "GOAL_PENALTY") &&
      !isShootout(e) &&
      !isVarCancelled(e, events),
  );
}

// A penalty "awarded" includes both scored and missed penalties — per
// spec, a penalty awarded and missed still produces YES for the "Penalty
// awarded" template. Excludes shootout penalties and VAR-overturned awards.
export function awardedPenalties(events: NormalizedFixtureEvent[]): NormalizedFixtureEvent[] {
  return events.filter(
    (e) =>
      (e.detail === "GOAL_PENALTY" || e.detail === "GOAL_PENALTY_MISSED") &&
      !isShootout(e) &&
      !isVarCancelled(e, events),
  );
}

// Direct reds always count; second-yellow dismissals only when the pool's
// own config explicitly includes them (spec requires the question text to
// state which rule applies — see match-events.ts's redCard template).
export function redCardEvents(
  events: NormalizedFixtureEvent[],
  includeSecondYellowDismissal: boolean,
): NormalizedFixtureEvent[] {
  return events.filter(
    (e) =>
      e.type === "CARD" &&
      (e.detail === "CARD_RED" || (includeSecondYellowDismissal && e.detail === "CARD_SECOND_YELLOW")),
  );
}
