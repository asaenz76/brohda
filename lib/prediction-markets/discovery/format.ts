/**
 * Centralized "closes at" formatting for discovery cards/detail — a simple,
 * static label computed server-side (deliberately not a live client-side
 * countdown, unlike the legacy pool engine's PoolSummary — this is a
 * browse/discovery surface, not a time-pressured commitment moment, so the
 * extra client JS a ticking countdown requires isn't justified here).
 */
export function formatClosesAt(closesAt: string | null): string | null {
  if (!closesAt) return null;
  const date = new Date(closesAt);
  if (Number.isNaN(date.getTime())) return null;
  // Explicit UTC — this renders server-side (a Server Component, not a
  // client-hydrated value), so leaving the timezone to the server host's
  // own configuration would make the displayed date non-deterministic
  // across environments for the exact same stored timestamp.
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
