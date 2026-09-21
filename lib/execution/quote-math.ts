// Pure Milestone 5 quote math — no I/O, so the whole depth-consumption/
// fee/slippage model is unit-testable with an explicit snapshot, matching
// this codebase's own convention (classifyFreshness, checkMarketEligibility,
// compareDiscoveryMarkets). Never derives NO from YES pricing, never
// fabricates liquidity beyond what the snapshot actually shows.
import type { DepthLevel, ExecutableMarketSnapshot, ExecutionPolicy, QuoteComputation } from "./types";

export type QuoteMathResult = { ok: true; computation: QuoteComputation } | { ok: false; reason: "INSUFFICIENT_LIQUIDITY" };

/**
 * Walks the ask side from best (lowest) price upward, consuming size at
 * each level until `requestedAmountCents` worth of shares has been
 * accumulated, exactly like a real BUY order matching against a CLOB's ask
 * side would (docs/architecture/simulated-execution.md §6/§10 — this
 * mirrors the actual documented matching direction, not a simplification).
 * If the entire book (as captured by this snapshot) can't fill the
 * requested amount, returns `INSUFFICIENT_LIQUIDITY` rather than
 * fabricating a fill beyond what the snapshot actually shows.
 */
function consumeDepth(askLevels: DepthLevel[], requestedAmountCents: number): { totalShares: number; totalCostCents: number } | null {
  const requestedDollars = requestedAmountCents / 100;
  let remainingDollars = requestedDollars;
  let totalShares = 0;
  let totalCostDollars = 0;

  for (const level of askLevels) {
    if (remainingDollars <= 0) break;
    const levelCostIfFullyConsumed = level.size * level.price;

    if (levelCostIfFullyConsumed <= remainingDollars) {
      totalShares += level.size;
      totalCostDollars += levelCostIfFullyConsumed;
      remainingDollars -= levelCostIfFullyConsumed;
    } else {
      const sharesFromLevel = remainingDollars / level.price;
      totalShares += sharesFromLevel;
      totalCostDollars += remainingDollars;
      remainingDollars = 0;
    }
  }

  if (remainingDollars > 0) return null;
  return { totalShares, totalCostCents: Math.round(totalCostDollars * 100) };
}

/**
 * Computes a full simulated Quote from a read-only snapshot and the
 * configured policy's fee assumptions. Slippage is measured against the
 * snapshot's own best ask (`currentPrice`) — never against a stale or
 * client-supplied reference price.
 */
export function computeQuote(
  snapshot: ExecutableMarketSnapshot,
  requestedAmountCents: number,
  policy: Pick<ExecutionPolicy, "simulatedProviderFeeBps" | "simulatedBrohdaFeeBps">,
): QuoteMathResult {
  const consumed = consumeDepth(snapshot.askLevels, requestedAmountCents);
  if (consumed === null) return { ok: false, reason: "INSUFFICIENT_LIQUIDITY" };

  const effectivePrice = consumed.totalShares > 0 ? consumed.totalCostCents / 100 / consumed.totalShares : snapshot.currentPrice;
  const estimatedGrossReturnCents = Math.round(consumed.totalShares * 100);

  const slippageBps =
    snapshot.currentPrice > 0 ? Math.max(0, Math.round(((effectivePrice - snapshot.currentPrice) / snapshot.currentPrice) * 10_000)) : 0;

  const providerFeeEstimateCents = Math.round((requestedAmountCents * policy.simulatedProviderFeeBps) / 10_000);
  const brohdaFeeEstimateCents = Math.round((requestedAmountCents * policy.simulatedBrohdaFeeBps) / 10_000);

  return {
    ok: true,
    computation: {
      currentPrice: snapshot.currentPrice,
      effectivePrice,
      estimatedUnits: consumed.totalShares,
      estimatedGrossReturnCents,
      providerFeeEstimateCents,
      brohdaFeeEstimateCents,
      totalFeeEstimateCents: providerFeeEstimateCents + brohdaFeeEstimateCents,
      estimatedSlippageBps: slippageBps,
    },
  };
}

/**
 * How far `newEffectivePrice` has moved from `originalEffectivePrice`, in
 * basis points — used at confirmation time (roadmap-adjacent decision,
 * Milestone 5 STEP 25) to decide whether a quote's original economics are
 * still honorable, never to silently re-price a confirmed quote.
 */
export function priceMovementBps(originalEffectivePrice: number, newEffectivePrice: number): number {
  if (originalEffectivePrice <= 0) return 0;
  return Math.round((Math.abs(newEffectivePrice - originalEffectivePrice) / originalEffectivePrice) * 10_000);
}
