// How Confidence is written everywhere a Member reads it. Pure and client-safe. The unit is "Confidence points"; the visual shorthand is the flame. Nothing here mentions money, a wallet or a payout.

export type ConfidenceEntryType = "INITIAL_GRANT" | "DAILY_CLAIM" | "ADMIN_ADJUSTMENT" | "REVERSAL";

/** "🔥47" — and the words a screen reader should say instead of the flame. */
export function formatConfidence(points: number): string {
  return `🔥${Math.trunc(points).toLocaleString("en-US")}`;
}

export function confidenceLabel(points: number): string {
  const n = Math.trunc(points);
  return `${n.toLocaleString("en-US")} Confidence`;
}

/** "+5🔥" / "−5🔥" (a real minus sign, as the product copy uses). */
export function formatSignedConfidence(delta: number): string {
  const n = Math.trunc(delta);
  return `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("en-US")}🔥`;
}

/** What a Member sees for each kind of entry. Admin reasons and notes are private and never part of this. */
export const ENTRY_DESCRIPTION: Record<ConfidenceEntryType, string> = {
  INITIAL_GRANT: "Initial Confidence",
  DAILY_CLAIM: "Daily Claim",
  ADMIN_ADJUSTMENT: "Adjustment by Brohda",
  REVERSAL: "Correction by Brohda",
};

export function describeEntry(type: string): string {
  return ENTRY_DESCRIPTION[type as ConfidenceEntryType] ?? "Confidence update";
}

/** "5h 12m" / "42m" / "less than a minute" — for a rolling wait computed from a real timestamp (never "tomorrow"). */
export function formatWait(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 1) return "less than a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** The future stake ladder: non-empty, strictly ascending, positive whole numbers, bounded. Mirrors the database check (confidence_stakes_valid). */
export const STAKE_LADDER_MAX_LENGTH = 10;
export const STAKE_MAX = 1000;
export function isValidStakeLadder(stakes: unknown): stakes is number[] {
  if (!Array.isArray(stakes) || stakes.length < 1 || stakes.length > STAKE_LADDER_MAX_LENGTH) return false;
  if (!stakes.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= STAKE_MAX)) return false;
  return stakes.every((s, i) => i === 0 || s > stakes[i - 1]);
}

/** Parses "1, 2, 3, 4, 5" from the admin form; returns null when it is not a whole-number list. */
export function parseStakeLadder(text: string): number[] | null {
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.map(Number);
}
