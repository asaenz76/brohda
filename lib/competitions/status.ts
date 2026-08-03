import { ACTIVATION_WINDOW_DAYS } from "./constants";

export type ImportStatusBadge = "NOT_IMPORTED" | "IMPORTING" | "IMPORTED" | "IMPORT_FAILED";

export type OperationalStatus = "ARCHIVED" | "NEEDS_ATTENTION" | "COMPLETED" | "ACTIVE" | "PREPARED" | "NO_UPCOMING_FIXTURES";

export const OPERATIONAL_STATUS_LABEL: Record<OperationalStatus, string> = {
  ARCHIVED: "Archived",
  NEEDS_ATTENTION: "Needs attention",
  COMPLETED: "Completed",
  ACTIVE: "Active",
  PREPARED: "Prepared",
  NO_UPCOMING_FIXTURES: "No upcoming fixtures",
};

export type NeedsAttentionReason =
  | "IMPORT_FAILED"
  | "SYNC_STALE"
  | "SYNC_FAILED"
  | "NEWER_SEASON_AVAILABLE"
  | "NO_UPCOMING_FIXTURES"
  | "SEASON_ENDED_NOT_ARCHIVED";

export const NEEDS_ATTENTION_LABEL: Record<NeedsAttentionReason, string> = {
  IMPORT_FAILED: "Import failed",
  SYNC_STALE: "Sync data is stale",
  SYNC_FAILED: "Last sync failed",
  NEWER_SEASON_AVAILABLE: "A newer season is now available",
  NO_UPCOMING_FIXTURES: "No upcoming fixtures",
  SEASON_ENDED_NOT_ARCHIVED: "Season has ended — consider archiving",
};

// Discovery is considered overdue (worth flagging, not just "due for its
// next tick") once it's this many multiples of its own interval overdue —
// a normal gap between ticks isn't a problem; a much longer gap suggests
// the cron itself may not be running.
const STALE_SYNC_MULTIPLIER = 3;

export interface CompetitionStatusInput {
  importStatus: "IMPORTING" | "IMPORTED" | "IMPORT_FAILED" | null; // null = no row = not imported
  syncStatus: "IDLE" | "SYNCING" | "STALE" | "FAILED" | null;
  isActive: boolean;
  archivedAt: string | null;
  seasonEndDate: string | null;
  lastFixtureDiscoveryAt: string | null;
  upcomingFixtureCount: number; // total future fixtures known, unwindowed
  fixtureCountImported: number;
  // Whether this exact (league, season) matches the provider's current
  // season as of the last availability-cache check — false/undefined
  // means a newer season may already be current and not yet imported.
  isLatestKnownSeason: boolean;
  discoverySyncIntervalHours: number;
  // Live, precise, always-fresh (unlike the periodic snapshot above) —
  // whether any eligible fixture falls inside the activation window.
  hasFixtureWithinActivationWindow: boolean;
  // Whether every fixture imported for this competition has reached a
  // terminal status (COMPLETED/CANCELLED/etc.) — the second half of
  // "Completed": a fixture-count-only heuristic (e.g. "0 upcoming") can't
  // distinguish a genuinely finished season from one that simply hasn't
  // had its next round's fixtures added yet, so this is measured directly
  // rather than inferred from counts.
  allKnownFixturesAreTerminal: boolean;
}

export function importStatusBadge(input: Pick<CompetitionStatusInput, "importStatus">): ImportStatusBadge {
  return input.importStatus ?? "NOT_IMPORTED";
}

function isCompleted(input: CompetitionStatusInput): boolean {
  if (input.seasonEndDate && new Date(input.seasonEndDate).getTime() < Date.now()) return true;
  return input.fixtureCountImported > 0 && input.allKnownFixturesAreTerminal;
}

export function getNeedsAttentionReasons(input: CompetitionStatusInput): NeedsAttentionReason[] {
  if (input.importStatus !== "IMPORTED") {
    return input.importStatus === "IMPORT_FAILED" ? ["IMPORT_FAILED"] : [];
  }

  const reasons: NeedsAttentionReason[] = [];

  if (input.syncStatus === "FAILED") reasons.push("SYNC_FAILED");
  else {
    const discoveryAgeMs = input.lastFixtureDiscoveryAt ? Date.now() - new Date(input.lastFixtureDiscoveryAt).getTime() : Infinity;
    if (discoveryAgeMs > input.discoverySyncIntervalHours * STALE_SYNC_MULTIPLIER * 3600_000) {
      reasons.push("SYNC_STALE");
    }
  }

  if (!input.isLatestKnownSeason) reasons.push("NEWER_SEASON_AVAILABLE");

  const completed = isCompleted(input);
  if (completed && input.isActive) reasons.push("SEASON_ENDED_NOT_ARCHIVED");
  else if (!completed && input.upcomingFixtureCount === 0) reasons.push("NO_UPCOMING_FIXTURES");

  return reasons;
}

/**
 * Exactly one operational status per competition — a precedence cascade,
 * not an independent classifier, so a row's badge is always unambiguous:
 * Archived (terminal) beats Needs attention (actionable) beats Completed
 * beats Active/Prepared/No-upcoming-fixtures (the normal lifecycle).
 */
export function computeOperationalStatus(input: CompetitionStatusInput): OperationalStatus | null {
  if (input.importStatus !== "IMPORTED") return null; // no operational status before a successful import

  if (!input.isActive) return "ARCHIVED";
  if (getNeedsAttentionReasons(input).length > 0) return "NEEDS_ATTENTION";
  if (isCompleted(input)) return "COMPLETED";
  if (input.hasFixtureWithinActivationWindow) return "ACTIVE";
  if (input.upcomingFixtureCount > 0) return "PREPARED";
  return "NO_UPCOMING_FIXTURES";
}

export { ACTIVATION_WINDOW_DAYS };
