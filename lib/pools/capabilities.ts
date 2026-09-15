// Centralizes every money-vs-free branch behind named predicates
// (FREE_MODE_ARCHITECTURE_PROPOSAL.md §4.3) instead of scattering
// `pool.entryMode === "FREE"` through dozens of call sites. Each predicate
// is a one-line function of entryMode today, but they're named apart from
// one another specifically so a future sponsored-prize FREE pool could
// make hasPrizePool/supportsCashPayout diverge from requiresPayment without
// renaming anything at any call site — that feature is explicitly not
// being built now, only kept possible.
export type EntryMode = "PAID" | "FREE";

interface ModePool {
  entryMode: EntryMode;
}

export function requiresPayment(pool: ModePool): boolean {
  return pool.entryMode === "PAID";
}

export function usesWallet(pool: ModePool): boolean {
  return requiresPayment(pool);
}

export function hasPrizePool(pool: ModePool): boolean {
  return pool.entryMode === "PAID";
}

export function showsEstimatedReturn(pool: ModePool): boolean {
  return hasPrizePool(pool);
}

export function requiresFinancialSettlement(pool: ModePool): boolean {
  return requiresPayment(pool);
}

export function supportsRefund(pool: ModePool): boolean {
  return pool.entryMode === "PAID";
}

export function supportsCashPayout(pool: ModePool): boolean {
  return hasPrizePool(pool);
}
