// THE ONE place a Brohda amount becomes a provider amount. Brohda stores every commercial amount in the currency's minor unit (cents). Every provider-supported
// currency below uses two decimal places, so minor units map 1:1 — but that is a fact stated here ONCE, per currency, so a currency with a different exponent can
// never silently be mis-scaled by code elsewhere assuming "× 100".
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = { USD: 2, CRC: 2, GTQ: 2, NIO: 2, PAB: 2, PEN: 2, MXN: 2, COP: 2, HNL: 2 };

export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(`unsupported_currency:${currency}`);
  }
}

export function isProviderSupportedCurrency(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENT, currency);
}

/** Brohda cents (minor units, an integer) → the integer minor-unit amount the provider expects. Never accepts a non-integer or non-positive amount. */
export function toProviderAmount(amountMinor: number, currency: string): number {
  if (!isProviderSupportedCurrency(currency)) throw new UnsupportedCurrencyError(currency);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new RangeError("amount must be a positive whole number of minor units");
  return amountMinor; // exponent is the provider's own and equals Brohda's for every supported currency (see table)
}

/** The provider's integer minor-unit amount → Brohda minor units, rejecting anything that is not an exact whole number. */
export function fromProviderAmount(providerAmount: unknown, currency: string): number | null {
  if (!isProviderSupportedCurrency(currency)) return null;
  if (typeof providerAmount !== "number" || !Number.isFinite(providerAmount) || !Number.isInteger(providerAmount) || providerAmount <= 0) return null;
  return providerAmount;
}

/** For display only ("1,234.50"): minor units → a decimal string using the currency's exponent. */
export function formatMinor(amountMinor: number, currency: string): string {
  const exponent = MINOR_UNIT_EXPONENT[currency] ?? 2;
  return (amountMinor / 10 ** exponent).toFixed(exponent);
}
