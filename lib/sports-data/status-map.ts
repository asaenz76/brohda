import type { FixtureInternalStatus } from "./types";

// Statuses that will never change again — the sync job stops polling them.
// Single source of truth: sync-nfl.ts builds its SQL exclusion filter from
// this array.
export const TERMINAL_STATUSES: readonly FixtureInternalStatus[] = [
  "COMPLETED",
  "CANCELLED",
  "ABANDONED",
  "AWARDED",
];

const TERMINAL_STATUS_SET: ReadonlySet<FixtureInternalStatus> = new Set(TERMINAL_STATUSES);

// API-NFL's short status codes. NS, FT, and AOT are confirmed live (NS/FT
// against /games?league=1&season=2026 while building the NFL provider; AOT
// found via a spot-check against the completed 2025 season — a regulation-
// tied game that goes to overtime finishes with status AOT ("After Over
// Time"), not FT, confirmed by status.long and by scores.*.total already
// including the overtime points in all 16 games observed with this code —
// 16 of 335 games in a season, ~5%, so this is not a rare tail case). The
// remaining in-progress/postponed codes below are inferred from API-
// Sports' shared convention across their other sport APIs, not yet
// observed on a real live or delayed game. Any code not listed here safely
// falls back to UNKNOWN (never NOT_STARTED/COMPLETED) — an unrecognized
// in-progress code just means sync.ts keeps polling it rather than mis-
// classifying it as done, which is why AOT mapping to UNKNOWN before this
// fix was a silent stuck-forever bug rather than a loud one: every pool on
// an overtime game would sit in AWAITING_RESULT/pending indefinitely,
// since gradeTemplatePool only grades internal_status === "COMPLETED".
const NFL_CODE_MAP: Record<string, FixtureInternalStatus> = {
  NS: "NOT_STARTED", // confirmed live
  FT: "COMPLETED", // confirmed live
  AOT: "COMPLETED", // confirmed live — "After Over Time"
  Q1: "LIVE",
  Q2: "LIVE",
  Q3: "LIVE",
  Q4: "LIVE",
  HT: "HALFTIME",
  OT: "EXTRA_TIME",
  PST: "POSTPONED",
  CANC: "CANCELLED",
  ABD: "ABANDONED",
};

export function normalizeApiNflStatus(code: string | null | undefined): FixtureInternalStatus {
  if (!code) return "UNKNOWN";
  return NFL_CODE_MAP[code.toUpperCase()] ?? "UNKNOWN";
}

export function isTerminalStatus(status: FixtureInternalStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The other API-Sports products (basketball, hockey, baseball) share the NFL API's short-code convention. Observed LIVE against real
// historical seasons (2024): hockey FT / AOT / AP / CANC, basketball FT / AOT / CANC, baseball FT / POST / CANC / ABD. Every other code below
// is taken from the vendor's published status list and has NOT been observed on a real game by us — exactly the NFL map's own convention. Any
// code not listed falls back to UNKNOWN (never COMPLETED / NOT_STARTED): an unrecognised in-progress code just means sync keeps polling it
// and no Market is graded, which is loud-by-omission rather than a silent mis-grade.
//
// The one lifecycle is shared with the NFL: COMPLETED is the only gradeable final, CANCELLED grades VOID, POSTPONED keeps the Game identity
// and keeps being tracked, and SUSPENDED / ABANDONED / AWARDED stay PENDING (never graded) until there is an owner policy for them.
// ---------------------------------------------------------------------------------------------------------------------------------
const API_SPORTS_COMMON_CODES: Record<string, FixtureInternalStatus> = {
  NS: "NOT_STARTED", // observed (every sport)
  FT: "COMPLETED", // observed — "Finished"
  AOT: "COMPLETED", // observed — "After Over Time": final score already includes the overtime
  CANC: "CANCELLED", // observed
  POST: "POSTPONED", // observed (baseball)
  ABD: "ABANDONED", // observed (baseball)
  SUSP: "SUSPENDED", // vendor list, not observed
  AWD: "AWARDED", // vendor list, not observed
};

const HOCKEY_CODE_MAP: Record<string, FixtureInternalStatus> = {
  ...API_SPORTS_COMMON_CODES,
  AP: "COMPLETED", // observed — "After Penalties": decided in a shootout; provider `scores` already credit the shootout winner (see api-sports-hockey)
  P1: "LIVE",
  P2: "LIVE",
  P3: "LIVE",
  BT: "LIVE", // intermission / break
  OT: "EXTRA_TIME",
  PT: "PENALTIES", // shootout in progress
};

const BASKETBALL_CODE_MAP: Record<string, FixtureInternalStatus> = {
  ...API_SPORTS_COMMON_CODES,
  Q1: "LIVE",
  Q2: "LIVE",
  Q3: "LIVE",
  Q4: "LIVE",
  BT: "LIVE",
  HT: "HALFTIME",
  OT: "EXTRA_TIME",
};

const BASEBALL_CODE_MAP: Record<string, FixtureInternalStatus> = {
  ...API_SPORTS_COMMON_CODES,
  IN1: "LIVE",
  IN2: "LIVE",
  IN3: "LIVE",
  IN4: "LIVE",
  IN5: "LIVE",
  IN6: "LIVE",
  IN7: "LIVE",
  IN8: "LIVE",
  IN9: "LIVE",
  // INTR ("Interrupted") is intentionally unmapped: whether it is a delay (play resumes) or a suspension is not knowable from the code.
};

function lookup(map: Record<string, FixtureInternalStatus>, code: string | null | undefined): FixtureInternalStatus {
  if (!code) return "UNKNOWN";
  return map[code.toUpperCase()] ?? "UNKNOWN";
}

export const normalizeApiHockeyStatus = (code: string | null | undefined) => lookup(HOCKEY_CODE_MAP, code);
export const normalizeApiBasketballStatus = (code: string | null | undefined) => lookup(BASKETBALL_CODE_MAP, code);
export const normalizeApiBaseballStatus = (code: string | null | undefined) => lookup(BASEBALL_CODE_MAP, code);
