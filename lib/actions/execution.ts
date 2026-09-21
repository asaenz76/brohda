"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requestQuote as requestQuoteService, confirmSimulatedExecution as confirmSimulationService } from "@/lib/execution/quote-service";
import { checkExecutionConfirmationRateLimit, checkExecutionQuoteRateLimit } from "@/lib/rate-limit/execution";
import { confirmSimulationSchema, requestQuoteSchema } from "@/lib/validations/execution";
import { copyForIneligible, copyForRejection } from "@/lib/execution/copy";

// Milestone 5's only two mutations. Both are authenticated, validated, and
// re-derive every financially-relevant fact server-side — the browser
// never calls Polymarket directly (docs/architecture/simulated-execution.md
// §5/§15) and never supplies authoritative economics (STEP 24). Neither
// function calls, imports, or references any provider order-placement
// capability — none exists anywhere in this codebase.

export interface RequestQuoteState {
  success: boolean;
  error: string | null;
  quote: {
    id: string;
    selectedSide: "YES" | "NO";
    requestedAmountCents: number;
    currentPrice: number;
    effectivePrice: number;
    estimatedGrossReturnCents: number;
    totalFeeEstimateCents: number;
    estimatedSlippageBps: number;
    expiresAt: string;
  } | null;
}

export async function requestQuoteAction(input: { marketId: string; selectedSide: "YES" | "NO"; requestedAmountCents: number }): Promise<RequestQuoteState> {
  const user = await requireUser();

  const parsed = requestQuoteSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Something about that request wasn't valid.", quote: null };
  }

  const allowed = await checkExecutionQuoteRateLimit(user.id);
  if (!allowed) {
    return { success: false, error: "Too many quote requests — please wait a moment and try again.", quote: null };
  }

  const result = await requestQuoteService(user.id, parsed.data.marketId, parsed.data.selectedSide, parsed.data.requestedAmountCents);
  if (!result.success) {
    return { success: false, error: copyForIneligible(result.reason), quote: null };
  }

  const { quote } = result;
  return {
    success: true,
    error: null,
    quote: {
      id: quote.id,
      selectedSide: quote.selectedSide,
      requestedAmountCents: quote.requestedAmountCents,
      currentPrice: quote.currentPrice,
      effectivePrice: quote.effectivePrice,
      estimatedGrossReturnCents: quote.estimatedGrossReturnCents,
      totalFeeEstimateCents: quote.totalFeeEstimateCents,
      estimatedSlippageBps: quote.estimatedSlippageBps,
      expiresAt: quote.expiresAt,
    },
  };
}

export interface ConfirmSimulationState {
  success: boolean;
  error: string | null;
  result: { lifecycleState: "SIMULATED_FILLED" | "SIMULATED_REJECTED"; resultReason: string | null } | null;
}

export async function confirmSimulationAction(input: { quoteId: string; idempotencyKey: string }): Promise<ConfirmSimulationState> {
  const user = await requireUser();

  const parsed = confirmSimulationSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Something about that confirmation wasn't valid.", result: null };
  }

  // Fail-closed by design (lib/rate-limit/execution.ts's own comment) —
  // unlike the quote-request check above, an infrastructure failure here
  // blocks the confirmation rather than allowing it.
  const allowed = await checkExecutionConfirmationRateLimit(user.id);
  if (!allowed) {
    return { success: false, error: "Too many confirmations — please wait a moment and try again.", result: null };
  }

  const result = await confirmSimulationService(user.id, parsed.data.quoteId, parsed.data.idempotencyKey);
  if (!result.success) {
    const message =
      result.reason === "QUOTE_NOT_FOUND"
        ? "That quote couldn't be found — please request a new one."
        : result.reason === "QUOTE_EXPIRED"
          ? "That quote has expired — please request a new one."
          : result.reason === "NOT_ELIGIBLE" || result.reason === "EXECUTION_DISABLED" || result.reason === "ROLLOUT_BLOCKED" || result.reason === "LIMIT_EXCEEDED"
            ? copyForIneligible(result.reason)
            : copyForRejection(result.reason);
    return { success: false, error: message, result: null };
  }

  revalidatePath("/profile");

  const { orderIntent } = result;
  return {
    success: true,
    error: orderIntent.resultReason ? copyForRejection(orderIntent.resultReason) : null,
    result: { lifecycleState: orderIntent.lifecycleState as "SIMULATED_FILLED" | "SIMULATED_REJECTED", resultReason: orderIntent.resultReason },
  };
}
