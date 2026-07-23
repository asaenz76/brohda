export interface ReversalWinner {
  userId: string;
  creditedAmount: number;
  currentBalance: number;
}

export interface ShortfallEntry {
  userId: string;
  creditedAmount: number;
  currentBalance: number;
  shortfall: number;
}

export interface ReversalFeasibility {
  feasible: boolean;
  report: ShortfallEntry[];
}

/**
 * Mirrors `reverse_pool_settlement`'s dry-run check (the SQL function is
 * authoritative — this is a pure, unit-tested copy of the same decision for
 * documentation and regression coverage). Spec §17.4: the report covers
 * every affected winner, not just the ones short — shortfall is 0 for
 * anyone who can absorb the clawback.
 */
export function checkReversalFeasibility(winners: ReversalWinner[]): ReversalFeasibility {
  const report: ShortfallEntry[] = winners.map((w) => ({
    userId: w.userId,
    creditedAmount: w.creditedAmount,
    currentBalance: w.currentBalance,
    shortfall: Math.max(w.creditedAmount - w.currentBalance, 0),
  }));

  const feasible = report.every((entry) => entry.shortfall === 0);

  return { feasible, report };
}
