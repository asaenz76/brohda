import type { SimulatedProviderState, SimulatedProviderStateSource } from "./types";

// Milestone 5.5 (STEP 26). Two state sources:
//
// `createFixtureProviderStateSource` — a deterministic, explicitly-keyed
// test double (STEP 26's own instruction: "prefer deterministic scenario
// configuration," never randomness unless seeded/configured). Used by unit
// and integration tests to exercise every STEP 22 scenario on demand.
//
// `defaultSimulatedProviderStateSource` — mirrors an OrderIntent's own
// already-recorded terminal state 1:1. This is what an admin-triggered
// "reconcile now" action uses against real (simulated) order_intents rows
// in the absence of any real external provider to actually check —
// running the algorithm against it should always yield IN_SYNC, which is
// itself a useful correctness property to test (STEP 45): the
// reconciliation engine must never invent a mismatch against data that
// hasn't actually changed.

export function createFixtureProviderStateSource(fixtures: Record<string, SimulatedProviderState>): SimulatedProviderStateSource {
  return {
    async getAuthoritativeState(orderIntentId: string): Promise<SimulatedProviderState> {
      return fixtures[orderIntentId] ?? { outcome: "MISSING" };
    },
  };
}

export function defaultSimulatedProviderStateSource(getExpected: (orderIntentId: string) => Promise<{ lifecycleState: string; filledAmountCents: number | null } | null>): SimulatedProviderStateSource {
  return {
    async getAuthoritativeState(orderIntentId: string): Promise<SimulatedProviderState> {
      const expected = await getExpected(orderIntentId);
      if (!expected) return { outcome: "MISSING" };
      if (expected.lifecycleState === "SIMULATED_FILLED") return { outcome: "ACCEPTED", filledAmountCents: expected.filledAmountCents ?? undefined };
      if (expected.lifecycleState === "SIMULATED_REJECTED") return { outcome: "REJECTED" };
      // CONFIRMED (non-terminal) has no authoritative counterpart to mirror yet.
      return { outcome: "UNAVAILABLE" };
    },
  };
}
