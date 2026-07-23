// Integer-minor-units money storage (spec §8.3). Formatting to $/% happens
// only here — never scatter Intl/float formatting across components.

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

const DOLLAR_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Parses a user-typed dollar amount ("10", "10.5", "10.50") into integer
 * cents without floating-point arithmetic. Returns null for anything that
 * isn't a clean positive amount (garbage input, too many decimal places,
 * negative, zero) rather than silently rounding.
 */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!DOLLAR_AMOUNT_PATTERN.test(trimmed)) return null;

  const [dollars, cents = ""] = trimmed.split(".");
  const paddedCents = cents.padEnd(2, "0");
  const totalCents = Number(dollars) * 100 + Number(paddedCents);

  return totalCents > 0 ? totalCents : null;
}

const PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Parses an admin-typed percentage ("10", "2.5") into integer basis points
 * (X.14: houseFeeBasisPoints is the canonical fee representation
 * end-to-end). Unlike parseDollarsToCents, 0 is valid — a 0% house fee is a
 * legitimate configuration (spec: zero fee on canceled/voided/refunded
 * pools). Rejects anything outside 0-100%.
 */
export function parsePercentToBps(input: string): number | null {
  const trimmed = input.trim();
  if (!PERCENT_PATTERN.test(trimmed)) return null;

  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(2, "0");
  const bps = Number(whole) * 100 + Number(paddedFraction);

  return bps >= 0 && bps <= 10000 ? bps : null;
}

/** Presentation-only: basis points -> "10%" / "2.5%" (X.6.6). */
export function formatBps(bps: number): string {
  const percent = bps / 100;
  const formatted = percent.toFixed(2).replace(/\.?0+$/, "");
  return `${formatted}%`;
}
