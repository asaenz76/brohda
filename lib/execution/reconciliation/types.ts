import type { OrderIntentLifecycleState } from "../types";

// Milestone 5.5 reconciliation domain (STEP 21-26). Every type here is
// provider-neutral and every state source Milestone 5.5 ever calls is
// simulated/deterministic — no real provider mutation API exists to call.

/**
 * The closed, provider-neutral vocabulary a simulated authoritative
 * provider-state source may report. Reviewed down to exactly the
 * scenarios STEP 22 asks for, not copied blindly from a generic list.
 */
export type SimulatedProviderOutcome = "ACCEPTED" | "REJECTED" | "MISSING" | "PARTIAL" | "CANCELLED" | "DUPLICATE" | "UNAVAILABLE" | "DELAYED" | "INCONSISTENT";

export interface SimulatedProviderState {
  outcome: SimulatedProviderOutcome;
  /** Present only for ACCEPTED/PARTIAL. */
  filledAmountCents?: number;
  note?: string;
}

/** What Brohda itself currently believes about one OrderIntent — never assumed authoritative (STEP 21). */
export interface ExpectedOrderState {
  lifecycleState: OrderIntentLifecycleState;
  filledAmountCents: number | null;
}

export interface SimulatedProviderStateSource {
  getAuthoritativeState(orderIntentId: string): Promise<SimulatedProviderState>;
}
