/**
 * Defensive fallback for rendering a DB enum value (snake_case or
 * SCREAMING_SNAKE_CASE) as plain text — "settlement_reversal_debit" ->
 * "Settlement reversal debit". Not a substitute for hand-written copy
 * (which should always be preferred where it exists); this exists so a
 * newly-added enum value that nobody's updated a label map for yet still
 * reads as a sentence instead of leaking raw internal identifiers.
 */
export function humanizeEnum(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
