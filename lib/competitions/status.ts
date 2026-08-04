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
  | "FIXTURE_COUNT_MISMATCH"
  | "UPCOMING_FIXTURES_NOT_IMPORTED"
  | "SEASON_METADATA_CONFLICT"
  | "NO_UPCOMING_FIXTURES"
  | "SEASON_ENDED_NOT_ARCHIVED";

// Short, generic labels — for the Health tab's fixed checklist (every
// possible reason, checked/unchecked) and badge counts. The precise,
// evidence-bearing sentence for a reason that's actually flagged lives in
// getNeedsAttentionDetails below, not here.
export const NEEDS_ATTENTION_LABEL: Record<NeedsAttentionReason, string> = {
  IMPORT_FAILED: "Import failed",
  SYNC_STALE: "Sync data is stale",
  SYNC_FAILED: "Last sync failed",
  NEWER_SEASON_AVAILABLE: "A newer season is now available",
  FIXTURE_COUNT_MISMATCH: "Imported fixture count differs from provider",
  UPCOMING_FIXTURES_NOT_IMPORTED: "No fixtures imported yet",
  SEASON_METADATA_CONFLICT: "Season metadata conflicts with fixture data",
  NO_UPCOMING_FIXTURES: "No upcoming fixtures",
  SEASON_ENDED_NOT_ARCHIVED: "Season has ended — consider archiving",
};

export type NeedsAttentionAction = "RUN_DISCOVERY" | "REFRESH_SEASON_METADATA" | "RETRY_IMPORT" | "REVIEW_FIXTURES" | "ARCHIVE";

export const NEEDS_ATTENTION_ACTION_LABEL: Record<NeedsAttentionAction, string> = {
  RUN_DISCOVERY: "Run discovery",
  REFRESH_SEASON_METADATA: "Refresh season metadata",
  RETRY_IMPORT: "Retry import",
  REVIEW_FIXTURES: "Review fixtures",
  ARCHIVE: "Archive",
};

// One flagged issue, with the actual evidence spelled out (real dates/
// counts/hours, not a generic sentence) and the action that would resolve
// it — see getNeedsAttentionDetails.
export interface NeedsAttentionDetail {
  code: NeedsAttentionReason;
  message: string;
  action: NeedsAttentionAction | null;
}

// Discovery is considered overdue (worth flagging, not just "due for its
// next tick") once it's this many multiples of its own interval overdue —
// a normal gap between ticks isn't a problem; a much longer gap suggests
// the cron itself may not be running.
const STALE_SYNC_MULTIPLIER = 3;

// timeZone: "UTC" is required, not cosmetic — season_end_date is a
// date-only value (parsed as UTC midnight); rendering it in the server's
// local timezone can shift the displayed day backward, as this did before
// the fix (verified failing in a non-UTC test environment).
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export interface CompetitionStatusInput {
  importStatus: "IMPORTING" | "IMPORTED" | "IMPORT_FAILED" | null; // null = no row = not imported
  syncStatus: "IDLE" | "SYNCING" | "STALE" | "FAILED" | null;
  isActive: boolean;
  archivedAt: string | null;
  seasonEndDate: string | null;
  lastFixtureDiscoveryAt: string | null;
  upcomingFixtureCount: number; // total future fixtures known, unwindowed
  fixtureCountImported: number;
  // The provider's own total fixture count for this competition/season, as
  // of the last discovery check — compared against fixtureCountImported to
  // catch a partial/incomplete import (FIXTURE_COUNT_MISMATCH), independent
  // of whether every fixture we do have happens to be terminal.
  providerFixtureCount: number | null;
  // The latest fixture date the provider itself reports for this
  // competition/season, as of the last discovery check — the one signal
  // that can actually confirm "no remaining fixtures," as opposed to
  // merely "none of the fixtures we happened to import are upcoming."
  // null means never checked, which must NOT be treated as confirmation.
  latestProviderFixtureAt: string | null;
  // Whether this exact (league, season) matches the provider's current
  // season as of the last availability-cache check — false/undefined
  // means a newer season may already be current and not yet imported.
  isLatestKnownSeason: boolean;
  discoverySyncIntervalHours: number;
  // Live, precise, always-fresh (unlike the periodic snapshot above) —
  // whether any eligible fixture falls inside the activation window.
  hasFixtureWithinActivationWindow: boolean;
  // Whether every fixture imported for this competition has reached a
  // terminal status (COMPLETED/CANCELLED/etc.) — necessary but never
  // sufficient on its own for "Completed": see isCompleted below for why
  // this always requires providerConfirmsNoRemainingFixtures too.
  allKnownFixturesAreTerminal: boolean;
}

export function importStatusBadge(input: Pick<CompetitionStatusInput, "importStatus">): ImportStatusBadge {
  return input.importStatus ?? "NOT_IMPORTED";
}

// The provider's own schedule confirms there's nothing left to play —
// i.e. the last fixture it reports for this competition/season is already
// in the past. `latestProviderFixtureAt == null` (discovery has never run)
// must never be read as confirmation — that's exactly the "no future
// imported fixture is currently found" trap the generic completion bug
// fell into.
function providerConfirmsNoRemainingFixtures(input: CompetitionStatusInput): boolean {
  return input.latestProviderFixtureAt != null && new Date(input.latestProviderFixtureAt).getTime() < Date.now();
}

// Completed only when a real "season is over" signal (a passed
// season_end_date, or every fixture we hold being terminal) is
// corroborated by the provider's own schedule confirming nothing remains.
// Neither signal alone is trusted: a season_end_date can be missing/wrong
// import-time metadata, and "every fixture we happen to have is terminal"
// is equally true of a healthy in-season competition whose next round
// simply hasn't been discovered yet (exactly what produced the MLS false
// positive — see status.test.ts for the regression case).
function isCompleted(input: CompetitionStatusInput): boolean {
  if (!providerConfirmsNoRemainingFixtures(input)) return false;
  const seasonEndPassed = input.seasonEndDate != null && new Date(input.seasonEndDate).getTime() < Date.now();
  if (seasonEndPassed) return true;
  return input.fixtureCountImported > 0 && input.allKnownFixturesAreTerminal;
}

/**
 * The full, evidence-bearing list of issues for one competition — each
 * message states the actual condition observed (a real date, count, or
 * hour figure), never a generic "something's wrong." Order is the
 * precedence a reader should act in, but every applicable issue is
 * included (not just the first), matching computeOperationalStatus's use
 * of "any issues at all" to trigger NEEDS_ATTENTION.
 */
export function getNeedsAttentionDetails(input: CompetitionStatusInput): NeedsAttentionDetail[] {
  if (input.importStatus !== "IMPORTED") {
    return input.importStatus === "IMPORT_FAILED"
      ? [{ code: "IMPORT_FAILED", message: "The last import attempt failed.", action: "RETRY_IMPORT" }]
      : [];
  }

  const details: NeedsAttentionDetail[] = [];

  if (input.syncStatus === "FAILED") {
    details.push({ code: "SYNC_FAILED", message: "The last discovery sync failed.", action: "RUN_DISCOVERY" });
  } else {
    const discoveryAgeMs = input.lastFixtureDiscoveryAt ? Date.now() - new Date(input.lastFixtureDiscoveryAt).getTime() : Infinity;
    const staleThresholdMs = input.discoverySyncIntervalHours * STALE_SYNC_MULTIPLIER * 3600_000;
    if (discoveryAgeMs > staleThresholdMs) {
      const hours = Number.isFinite(discoveryAgeMs) ? Math.round(discoveryAgeMs / 3600_000) : null;
      details.push({
        code: "SYNC_STALE",
        message: hours != null
          ? `Fixture discovery has not run in ${hours} hour${hours === 1 ? "" : "s"}.`
          : "Fixture discovery has never run for this competition.",
        action: "RUN_DISCOVERY",
      });
    }
  }

  if (!input.isLatestKnownSeason) {
    details.push({ code: "NEWER_SEASON_AVAILABLE", message: "A newer provider season is available.", action: "REFRESH_SEASON_METADATA" });
  }

  if (input.providerFixtureCount != null && input.providerFixtureCount !== input.fixtureCountImported) {
    details.push({
      code: "FIXTURE_COUNT_MISMATCH",
      message: `API-Football reports ${input.providerFixtureCount} fixture${input.providerFixtureCount === 1 ? "" : "s"}, but ${input.fixtureCountImported} ${input.fixtureCountImported === 1 ? "is" : "are"} imported.`,
      action: "REVIEW_FIXTURES",
    });
  }

  const completed = isCompleted(input);
  const seasonEndInFuture = input.seasonEndDate != null && new Date(input.seasonEndDate).getTime() >= Date.now();
  const seasonEndPassedButProviderDisagrees =
    input.seasonEndDate != null && new Date(input.seasonEndDate).getTime() < Date.now() && !providerConfirmsNoRemainingFixtures(input);

  if (completed && input.isActive) {
    details.push({
      code: "SEASON_ENDED_NOT_ARCHIVED",
      message: input.seasonEndDate
        ? `This competition's season ended on ${formatDate(input.seasonEndDate)}. Consider archiving it.`
        : "This competition's season has ended. Consider archiving it.",
      action: "ARCHIVE",
    });
  } else if (!completed && seasonEndInFuture && input.upcomingFixtureCount === 0 && input.fixtureCountImported === 0) {
    // Nothing has been imported for this competition at all yet — not a
    // metadata disagreement, just an import that hasn't happened (or
    // hasn't successfully happened) yet. Distinct from the branch below,
    // which requires fixtures to already be imported before it's a real
    // conflict.
    details.push({
      code: "UPCOMING_FIXTURES_NOT_IMPORTED",
      message: `No fixtures have been imported for this competition yet, and its provider season runs through ${formatDate(input.seasonEndDate!)}. Run Sync to check the provider and import any that are scheduled.`,
      action: "RUN_DISCOVERY",
    });
  } else if (!completed && seasonEndInFuture && input.upcomingFixtureCount === 0) {
    details.push({
      code: "SEASON_METADATA_CONFLICT",
      message: `Provider season ends on ${formatDate(input.seasonEndDate!)}, but no upcoming fixtures are imported.`,
      action: "RUN_DISCOVERY",
    });
  } else if (!completed && seasonEndPassedButProviderDisagrees) {
    details.push({
      code: "SEASON_METADATA_CONFLICT",
      message: "Season metadata conflicts with fixture dates.",
      action: "REFRESH_SEASON_METADATA",
    });
  } else if (!completed && input.upcomingFixtureCount === 0) {
    details.push({
      code: "NO_UPCOMING_FIXTURES",
      message: "No future fixtures were found after the last discovery sync.",
      action: "RUN_DISCOVERY",
    });
  }

  return details;
}

export function getNeedsAttentionReasons(input: CompetitionStatusInput): NeedsAttentionReason[] {
  return getNeedsAttentionDetails(input).map((d) => d.code);
}

// SEASON_ENDED_NOT_ARCHIVED and NO_UPCOMING_FIXTURES describe the exact
// same condition the COMPLETED / NO_UPCOMING_FIXTURES operational states
// already represent — they're advisory ("you may want to archive this" /
// "here's why nothing's upcoming"), not a problem on top of the normal
// lifecycle. Treating them as badge-forcing (as an earlier version of
// this file did) made those two operational states literally
// unreachable: any completed-but-still-active competition always had
// SEASON_ENDED_NOT_ARCHIVED in its reasons, so it could never actually
// show "Completed"; same for NO_UPCOMING_FIXTURES. Only a genuine problem
// — a failed/stale sync, a metadata conflict, a stale season, a fixture
// count mismatch — should preempt the normal lifecycle badge.
const ADVISORY_ONLY_REASONS = new Set<NeedsAttentionReason>(["SEASON_ENDED_NOT_ARCHIVED", "NO_UPCOMING_FIXTURES"]);

function hasSevereNeedsAttentionIssue(input: CompetitionStatusInput): boolean {
  return getNeedsAttentionDetails(input).some((d) => !ADVISORY_ONLY_REASONS.has(d.code));
}

/**
 * Exactly one operational status per competition — a precedence cascade,
 * not an independent classifier, so a row's badge is always unambiguous:
 * Archived (terminal) beats Needs attention (actionable) beats Active/
 * Prepared/Completed/No-upcoming-fixtures (the normal lifecycle).
 */
export function computeOperationalStatus(input: CompetitionStatusInput): OperationalStatus | null {
  if (input.importStatus !== "IMPORTED") return null; // no operational status before a successful import

  if (!input.isActive) return "ARCHIVED";
  if (hasSevereNeedsAttentionIssue(input)) return "NEEDS_ATTENTION";
  // Active/Prepared are checked before Completed, not after — a real
  // eligible or future fixture in hand always outranks an inferred
  // "season over" signal. Correct data should make these mutually
  // exclusive anyway (isCompleted requires the provider to confirm
  // nothing remains), but ordering it this way is a deliberate second
  // line of defense against exactly the kind of stale/incomplete
  // provider-metadata mismatch that caused the original false positive.
  if (input.hasFixtureWithinActivationWindow) return "ACTIVE";
  if (input.upcomingFixtureCount > 0) return "PREPARED";
  if (isCompleted(input)) return "COMPLETED";
  return "NO_UPCOMING_FIXTURES";
}

export { ACTIVATION_WINDOW_DAYS };
