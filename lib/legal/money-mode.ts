// What the legal pages may say about the optional money layer, decided in ONE place from two facts:
//
//   1. Is optional money on for consumers?  — the canonical consumer capability (lib/monetary/capability.ts → monetary_p2p_enabled). There is no
//      second legal-page flag. Fails CLOSED: an unreadable setting reads as off.
//   2. Does Brohda still hold financial records?  — wallet ledger entries, offers / Positions, withdrawal requests, balances. This is a FACT about
//      stored data, not a feature flag, and it is what keeps the Privacy Policy and Terms accurate after the feature is switched off.
//
//   active    money is on: the current-product copy that explains it (offers, wallet funding, settlement, the fee, who sees a Position).
//   retained  money is off but financial records exist (or cannot be ruled out): NO current-feature copy — but the stable disclosure the records
//             require stays (what is kept, who can see it, retention, how an existing balance is withdrawn, what closing an account does).
//   free      money is off and nothing financial was ever stored: the pages read as the free social product they are, with no money language at all.
//
// Fail-safe direction, deliberately asymmetric: an unreadable FLAG hides the consumer money copy; an unreadable RECORDS check keeps the disclosure
// (we never claim "no financial data" on a guess). Pure derivation below; the loader is the only I/O.

export type LegalMoneyMode = "active" | "retained" | "free";

export function deriveLegalMoneyMode({ flagEnabled, retainsFinancialRecords }: { flagEnabled: boolean | null; retainsFinancialRecords: boolean | null }): LegalMoneyMode {
  if (flagEnabled === true) return "active";
  // flagEnabled false or unreadable: no consumer money copy. Disclosure stays unless we KNOW there is nothing to disclose.
  return retainsFinancialRecords === false ? "free" : "retained";
}

/** Picks the content for a mode. All three are required on purpose (null = render nothing): a section cannot forget a mode, so money copy cannot leak into one by default. */
export function byMode<T>(mode: LegalMoneyMode, variants: { active: T; retained: T; free: T }): T {
  return variants[mode];
}

/** Like byMode, but only the chosen variant is evaluated — for variants that call something that must not run for a hidden mode (e.g. a cross-reference to a section the mode does not show). */
export function byModeLazy<T>(mode: LegalMoneyMode, variants: { active: () => T; retained: () => T; free: () => T }): T {
  return variants[mode]();
}
