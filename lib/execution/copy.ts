import type { ExecutionIneligibleReason, OrderIntentRejectionReason } from "./types";

/**
 * Consumer-facing copy for simulated-execution failures — never a raw
 * provider/internal message, never exchange jargon (roadmap STEP 26,
 * unchanged for the simulation). Shared between the Server Action and any
 * pre-submission UI display, mirroring lib/predictions/copy.ts's own
 * consolidation precedent.
 */
export function copyForIneligible(reason: ExecutionIneligibleReason): string {
  switch (reason) {
    case "SIMULATION_DISABLED":
      return "Simulated predictions aren't available right now.";
    case "MARKET_NOT_FOUND":
      return "This market couldn't be found.";
    case "MARKET_CLOSED":
      return "This market isn't open for a simulated prediction right now.";
    case "MARKET_INACTIVE":
      return "This market isn't open for a simulated prediction right now.";
    case "STALE_DATA":
      return "This market's pricing data is too old to simulate right now — try again in a moment.";
    case "PROVIDER_UNAVAILABLE":
      return "We can't reach live pricing for this market right now — try again in a moment.";
    case "INSUFFICIENT_LIQUIDITY":
      return "There isn't enough simulated liquidity to estimate this amount right now.";
    case "AMOUNT_OUT_OF_RANGE":
      return "That amount is outside the allowed range for a simulated prediction.";
    case "SLIPPAGE_TOO_HIGH":
      return "The estimated price impact for this amount is too high right now.";
    case "NOT_ELIGIBLE":
      return "This market isn't eligible for a simulated prediction right now.";
    case "EXECUTION_DISABLED":
      return "Simulated predictions are temporarily unavailable.";
    case "ROLLOUT_BLOCKED":
      return "This feature isn't available for your account yet.";
    case "LIMIT_EXCEEDED":
      return "This exceeds a configured limit right now.";
  }
}

export function copyForRejection(reason: OrderIntentRejectionReason): string {
  switch (reason) {
    case "MARKET_CLOSED":
      return "This market closed before your simulation could be confirmed.";
    case "STALE_DATA":
      return "Pricing changed too much to confirm — please request a new quote.";
    case "INSUFFICIENT_LIQUIDITY":
      return "There wasn't enough simulated liquidity left to confirm this amount.";
    case "SLIPPAGE_TOO_HIGH":
      return "The price moved more than allowed since your quote — please request a new quote.";
    case "NOT_ELIGIBLE":
      return "This market is no longer eligible for a simulated prediction.";
  }
}
