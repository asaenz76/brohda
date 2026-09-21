import { describe, expect, it } from "vitest";
import { computeQuote, priceMovementBps } from "@/lib/execution/quote-math";
import type { ExecutableMarketSnapshot } from "@/lib/execution/types";

/**
 * Pure Milestone 5 quote math, in isolation from any database or network
 * call. Never derives NO from YES pricing — each test constructs its own
 * independent snapshot; never fabricates liquidity beyond what the
 * snapshot's own ask levels provide.
 */

function snapshot(askLevels: { price: number; size: number }[], currentPrice?: number): ExecutableMarketSnapshot {
  return {
    currentPrice: currentPrice ?? askLevels[0]?.price ?? 0,
    askLevels,
    tickSize: 0.01,
    minOrderSize: 5,
    snapshotAt: "2026-01-01T00:00:00Z",
  };
}

const FEE_POLICY = { simulatedProviderFeeBps: 100, simulatedBrohdaFeeBps: 0 };

describe("computeQuote", () => {
  it("fills entirely within the best price level when depth is sufficient (a simple YES quote)", () => {
    const result = computeQuote(snapshot([{ price: 0.5, size: 1000 }]), 1000, FEE_POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $10 / $0.50 = 20 shares
    expect(result.computation.estimatedUnits).toBeCloseTo(20, 6);
    expect(result.computation.effectivePrice).toBeCloseTo(0.5, 6);
    expect(result.computation.estimatedSlippageBps).toBe(0);
    // 20 shares * $1 (if correct) = $20 = 2000 cents
    expect(result.computation.estimatedGrossReturnCents).toBe(2000);
  });

  it("computes symmetrically for a NO-side snapshot — no derivation from YES", () => {
    const result = computeQuote(snapshot([{ price: 0.3, size: 1000 }]), 1000, FEE_POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.computation.currentPrice).toBe(0.3);
    expect(result.computation.estimatedUnits).toBeCloseTo(1000 / 100 / 0.3, 6);
  });

  it("walks multiple price levels and computes a depth-weighted average execution price", () => {
    // best ask 0.50 for 10 shares ($5), next level 0.55 for the remainder.
    const result = computeQuote(
      snapshot([
        { price: 0.5, size: 10 },
        { price: 0.55, size: 1000 },
      ]),
      1000, // $10 requested
      FEE_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $5 buys 10 shares at 0.50; remaining $5 buys 5/0.55 shares at 0.55.
    const expectedShares = 10 + 5 / 0.55;
    expect(result.computation.estimatedUnits).toBeCloseTo(expectedShares, 6);
    const expectedEffectivePrice = 10 / expectedShares;
    expect(result.computation.effectivePrice).toBeCloseTo(expectedEffectivePrice, 6);
    expect(result.computation.effectivePrice).toBeGreaterThan(0.5);
  });

  it("reports positive slippage in basis points when the effective price exceeds the best price", () => {
    const result = computeQuote(
      snapshot([
        { price: 0.5, size: 10 },
        { price: 0.6, size: 1000 },
      ]),
      2000, // $20 — forces walking into the second level
      FEE_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.computation.estimatedSlippageBps).toBeGreaterThan(0);
  });

  it("returns INSUFFICIENT_LIQUIDITY, never a fabricated fill, when the book can't cover the requested amount", () => {
    const result = computeQuote(snapshot([{ price: 0.5, size: 5 }]), 10_000, FEE_POLICY); // $100 requested, book only has $2.50
    expect(result).toEqual({ ok: false, reason: "INSUFFICIENT_LIQUIDITY" });
  });

  it("returns INSUFFICIENT_LIQUIDITY for an entirely empty book", () => {
    const result = computeQuote(snapshot([]), 1000, FEE_POLICY);
    expect(result).toEqual({ ok: false, reason: "INSUFFICIENT_LIQUIDITY" });
  });

  it("computes the simulated provider and Brohda fees from configured bps, never hard-coded", () => {
    const result = computeQuote(snapshot([{ price: 0.5, size: 1000 }]), 10_000, { simulatedProviderFeeBps: 100, simulatedBrohdaFeeBps: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 100bps of 10000 cents = 100 cents; 50bps = 50 cents.
    expect(result.computation.providerFeeEstimateCents).toBe(100);
    expect(result.computation.brohdaFeeEstimateCents).toBe(50);
    expect(result.computation.totalFeeEstimateCents).toBe(150);
  });

  it("rounds gross return and fees to whole cents", () => {
    const result = computeQuote(snapshot([{ price: 0.333, size: 1000 }]), 1000, FEE_POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isInteger(result.computation.estimatedGrossReturnCents)).toBe(true);
    expect(Number.isInteger(result.computation.providerFeeEstimateCents)).toBe(true);
    expect(Number.isInteger(result.computation.totalFeeEstimateCents)).toBe(true);
  });

  it("uses the snapshot's own best price as currentPrice, never a client-supplied reference", () => {
    const result = computeQuote(snapshot([{ price: 0.42, size: 1000 }]), 500, FEE_POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.computation.currentPrice).toBe(0.42);
  });
});

describe("priceMovementBps", () => {
  it("is zero when prices are identical", () => {
    expect(priceMovementBps(0.5, 0.5)).toBe(0);
  });

  it("computes the absolute basis-point movement regardless of direction", () => {
    expect(priceMovementBps(0.5, 0.51)).toBe(200); // 2% = 200bps
    expect(priceMovementBps(0.5, 0.49)).toBe(200);
  });

  it("does not divide by zero for a degenerate original price", () => {
    expect(priceMovementBps(0, 0.5)).toBe(0);
  });
});
