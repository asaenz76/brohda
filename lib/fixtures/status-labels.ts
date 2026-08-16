// Admin-friendly display labels for FixtureInternalStatus — Phase 4 spec
// §29. No existing display vocabulary for this before Events: both
// pre-existing fixture-list components (local-fixture-groups.tsx,
// date-mode/fixture-date-groups.tsx) render the raw internal status value
// verbatim. This is purely a presentation layer over the same normalized
// enum every provider mapping (status-map.ts) already funnels into — it
// does not change what's stored or how sync/grading reads status.
import type { FixtureInternalStatus } from "@/lib/sports-data/types";

export const EVENT_STATUS_LABEL: Record<FixtureInternalStatus, string> = {
  NOT_STARTED: "Upcoming",
  LIVE: "Live",
  HALFTIME: "Live",
  EXTRA_TIME: "Live",
  PENALTIES: "Live",
  COMPLETED: "Final",
  POSTPONED: "Postponed",
  SUSPENDED: "Suspended",
  ABANDONED: "Abandoned",
  CANCELLED: "Cancelled",
  AWARDED: "Final",
  UNKNOWN: "Unknown",
};

/** Distinguishes "live right now" from every other bucket for badge tone —
 * separate from local-browse.ts's StatusBucket (UPCOMING/LIVE/COMPLETED/
 * OTHER), which exists for filtering/counting, not display styling. */
export function isLiveStatus(status: FixtureInternalStatus): boolean {
  return status === "LIVE" || status === "HALFTIME" || status === "EXTRA_TIME" || status === "PENALTIES";
}
