// How Confidence is written everywhere a Member reads it. Pure and client-safe. The unit is "Confidence points"; the visual shorthand is the flame. Nothing here mentions money, a wallet or a payout.

export type ConfidenceEntryType = "INITIAL_GRANT" | "DAILY_CLAIM" | "ADMIN_ADJUSTMENT" | "REVERSAL" | "PREDICTION_RESERVE" | "PREDICTION_RELEASE" | "PREDICTION_WIN" | "PREDICTION_LOSS";

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
  PREDICTION_RESERVE: "Prediction reserved",
  PREDICTION_RELEASE: "Prediction void",
  PREDICTION_WIN: "Prediction correct",
  PREDICTION_LOSS: "Prediction incorrect",
};

/**
 * How one ledger entry reads to the Member: what changed in the number they care about and, for a reserve/release, the plain-language movement between available and reserved. A reserve does not change the
 * total, so it is shown as the amount set aside (not a loss); a correct Pick is +N net (the N is returned and N new is issued); an incorrect Pick is −N; a void returns the N.
 */
export function describeEntryChange(type: string, availableDelta: number, reservedDelta: number): { headline: string; detail: string | null } {
  const total = availableDelta + reservedDelta;
  switch (type) {
    case "PREDICTION_RESERVE":
      return { headline: `${formatConfidence(reservedDelta)} reserved`, detail: `−${Math.abs(availableDelta)} available · +${reservedDelta} reserved` };
    case "PREDICTION_WIN":
      return { headline: formatSignedConfidence(total), detail: null };
    case "PREDICTION_LOSS":
      return { headline: formatSignedConfidence(total), detail: null };
    case "PREDICTION_RELEASE":
      return { headline: `${formatConfidence(availableDelta)} returned`, detail: null };
    default:
      return { headline: formatSignedConfidence(total), detail: null };
  }
}

/** One flame per point of a choice, for the ladder: 🔥, 🔥🔥, 🔥🔥🔥 … (the accessible label is always the number in words). */
export function flames(points: number): string {
  return "🔥".repeat(Math.max(0, Math.trunc(points)));
}

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

/**
 * The largest value any Confidence number setting (baseline, interval hours, a stake) can hold: the database column type is a 32-bit integer, so this is a genuine technical limit — not a product choice. Everything
 * below it (how big the baseline is, how long the interval, how many stakes and how large) is product policy chosen in Settings.
 */
export const INT4_MAX = 2_147_483_647;

/** The future stake ladder: non-empty, strictly ascending, positive whole numbers. Mirrors the database check (confidence_stakes_valid). */
export function isValidStakeLadder(stakes: unknown): stakes is number[] {
  if (!Array.isArray(stakes) || stakes.length < 1) return false;
  if (!stakes.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= INT4_MAX)) return false;
  return stakes.every((s, i) => i === 0 || s > stakes[i - 1]);
}

/** Parses "1, 2, 3, 4, 5" from the admin form; returns null when it is not a whole-number list. */
export function parseStakeLadder(text: string): number[] | null {
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** The most flames drawn in a row before a ladder choice is written as 🔥N instead — a layout bound for the selector's width, not a product limit (any ladder works). */
export const FLAME_ROW_MAX = 5;
export function ladderFlames(points: number): string {
  return points <= FLAME_ROW_MAX ? flames(points) : formatConfidence(points);
}

/**
 * What a prediction card needs to know about the viewer's Confidence to compose a prediction: the configured ladder, their AVAILABLE balance, and whether a Daily Claim is open to them (for the "you need Confidence" state).
 * Null when predictions are unavailable (Confidence or backed predictions are off, or the viewer has no account). It is presentation only: the database decides every prediction.
 */
export interface ConfidenceOffer {
  available: number;
  allowedStakes: number[];
  canClaim: boolean;
  /** Brohda 2.1: show the two-step composer (team first, Confidence optional) — optional Picks are on AND the UI flag is on. */
  twoStep?: boolean;
}
