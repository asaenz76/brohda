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

export function isTerminalStatus(status: FixtureInternalStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}
