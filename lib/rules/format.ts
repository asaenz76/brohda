// Presentation of the few mutable product values the Rules page quotes.
// Pure (no I/O), so the wording rules are unit-testable on their own. Every
// formatter takes `null` — "we could not read the live value" — and the page
// then falls back to generic wording instead of a stale number.

export interface RulesPolicy {
  /** Minutes before kickoff that Picks lock; null if unreadable. */
  lockMinutesBeforeKickoff: number | null;
  /** The platform fee in basis points (100 = 1%); null if unreadable. */
  feeBps: number | null;
  minStakeCents: number | null;
  maxStakeCents: number | null;
  /** Whether optional money offers are currently switched on; null if unreadable. */
  monetaryEnabled: boolean | null;
  /** Whether Call BS is currently switched on; null if unreadable. */
  callBsEnabled: boolean | null;
}

export const UNKNOWN_RULES_POLICY: RulesPolicy = {
  lockMinutesBeforeKickoff: null,
  feeBps: null,
  minStakeCents: null,
  maxStakeCents: null,
  monetaryEnabled: null,
  callBsEnabled: null,
};

/** "10 minutes before kickoff" / "1 minute before kickoff" / "at kickoff" / generic when unknown. */
export function describeLockWindow(minutes: number | null): string {
  if (minutes === null) return "shortly before kickoff";
  if (minutes <= 0) return "at kickoff";
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} before kickoff`;
}

/** The same cutoff, phrased as a deadline: "until 10 minutes before kickoff". */
export function describePickDeadline(minutes: number | null): string {
  if (minutes === null) return "until shortly before kickoff";
  if (minutes <= 0) return "until kickoff";
  return `until ${describeLockWindow(minutes)}`;
}

/** 100 -> "1%", 150 -> "1.5%", 25 -> "0.25%", 0 -> "0%". Null when unknown. */
export function formatFeePercent(bps: number | null): string | null {
  if (bps === null) return null;
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : parseFloat(percent.toFixed(2))}%`;
}

/** 100 -> "$1", 10000 -> "$100", 150 -> "$1.50". */
export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars.toLocaleString("en-US")}` : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "between $1 and $100" when both limits are known and sane; otherwise null (the caller uses generic wording). */
export function describeStakeLimits(minCents: number | null, maxCents: number | null): string | null {
  if (minCents === null || maxCents === null || minCents < 0 || maxCents < minCents) return null;
  return `between ${formatDollars(minCents)} and ${formatDollars(maxCents)}`;
}
