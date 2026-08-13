import type { FixtureInternalStatus } from "./types";

// API-Football's real short status codes, mapped to our internal enum.
// Application logic reads ONLY FixtureInternalStatus, never these codes.
const CODE_MAP: Record<string, FixtureInternalStatus> = {
  TBD: "NOT_STARTED",
  NS: "NOT_STARTED",
  "1H": "LIVE",
  "2H": "LIVE",
  LIVE: "LIVE",
  HT: "HALFTIME",
  ET: "EXTRA_TIME",
  BT: "EXTRA_TIME", // Break Time during extra time
  P: "PENALTIES",
  FT: "COMPLETED",
  AET: "COMPLETED",
  PEN: "COMPLETED",
  PST: "POSTPONED",
  SUSP: "SUSPENDED",
  INT: "SUSPENDED", // Interrupted
  ABD: "ABANDONED",
  CANC: "CANCELLED",
  AWD: "AWARDED",
  WO: "AWARDED", // WalkOver
};

// Statuses that will never change again — the sync job stops polling them
// ("stopping on final/cancelled", spec §9). Single source of truth: sync.ts
// builds its SQL exclusion filter from this array.
export const TERMINAL_STATUSES: readonly FixtureInternalStatus[] = [
  "COMPLETED",
  "CANCELLED",
  "ABANDONED",
  "AWARDED",
];

const TERMINAL_STATUS_SET: ReadonlySet<FixtureInternalStatus> = new Set(TERMINAL_STATUSES);

export function normalizeApiFootballStatus(code: string | null | undefined): FixtureInternalStatus {
  if (!code) return "UNKNOWN";
  return CODE_MAP[code.toUpperCase()] ?? "UNKNOWN";
}

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
