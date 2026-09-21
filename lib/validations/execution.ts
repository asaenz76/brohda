import { z } from "zod";

// Simulated-execution input validation — mirrors lib/validations/predictions.ts.

export const requestQuoteSchema = z.object({
  marketId: z.string().uuid(),
  selectedSide: z.enum(["YES", "NO"]),
  // Cents integer, matching this codebase's existing entry-fee-cents
  // convention — never a floating-point dollar amount.
  requestedAmountCents: z.number().int().positive(),
});
export type RequestQuoteInput = z.infer<typeof requestQuoteSchema>;

export const confirmSimulationSchema = z.object({
  quoteId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
});
export type ConfirmSimulationInput = z.infer<typeof confirmSimulationSchema>;
