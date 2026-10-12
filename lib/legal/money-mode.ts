// What the Member-facing legal and policy pages (/terms, /rules, /privacy) may say about the optional money layer, decided in ONE place from ONE fact:
//
//   Is Member monetary P2P on?  — the canonical consumer capability (lib/monetary/capability.ts → monetary_p2p_enabled). There is no second legal-page flag, no
//   environment switch and no per-page interpretation. It fails CLOSED: an unreadable, missing or malformed setting reads as OFF.
//
//   active    money is ON: the approved current-product copy that explains it (offers, wallet funding, settlement, the fee, who sees a Position, the
//             disclaimers and risk allocation that go with it).
//   free      money is OFF: the pages describe the product as it is today — Picks, comments, Call BS, results, reputation — with NO language about Member
//             money, wagers, wallets, balances, deposits, withdrawals, Positions, settlement, fees or payment methods, and no reference to any
//             historical money activity. Internal records are untouched; this only governs what is PUBLISHED.
//   retained  (dormant) the earlier "money is off but records still exist" variant: no current-feature copy, but a historical-records disclosure. The OWNER's
//             direction is that nothing about Member money is visible while the capability is off, so the policy below NEVER selects it. The approved
//             wording is kept in the documents (not deleted) so that, if counsel ever determines a historical-records disclosure is legally required, bringing
//             it back is a one-line change here — and a decision to make deliberately, not by accident.
//
// Sponsor surfaces (/sponsor/terms, the media agreement, the Sponsor section of the Privacy Policy) are a different product domain and do not follow this mode.

export type LegalMoneyMode = "active" | "retained" | "free";

/** Pure derivation. Anything other than a definite `true` is OFF — including an unreadable setting (null). */
export function deriveLegalMoneyMode({ flagEnabled }: { flagEnabled: boolean | null }): LegalMoneyMode {
  return flagEnabled === true ? "active" : "free";
}

/** True only when Member money copy may be shown. The single question every Member-facing legal/policy surface asks. */
export const showsMemberMoney = (mode: LegalMoneyMode): boolean => mode === "active";

/** Picks the content for a mode. All three are required on purpose (null = render nothing): a section cannot forget a mode, so money copy cannot leak into one by default. */
export function byMode<T>(mode: LegalMoneyMode, variants: { active: T; retained: T; free: T }): T {
  return variants[mode];
}

/** Like byMode, but only the chosen variant is evaluated — for variants that call something that must not run for a hidden mode (e.g. a cross-reference to a section the mode does not show). */
export function byModeLazy<T>(mode: LegalMoneyMode, variants: { active: () => T; retained: () => T; free: () => T }): T {
  return variants[mode]();
}
