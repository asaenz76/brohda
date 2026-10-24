import { z } from "zod";

// Prediction submission input validation — mirrors this codebase's existing
// convention (lib/validations/discovery.ts, lib/validations/pools.ts).
//
// A prediction is a side AND the Confidence behind it: there is no way to submit a side alone. The amount is only checked to be a positive whole
// number here; whether it is one of the configured choices (platform_settings.confidence_allowed_stakes) is the database's decision.

export const commitPredictionSchema = z.object({
  marketId: z.string().uuid(),
  selectedOutcome: z.enum(["YES", "NO"]),
  amount: z.number().int().min(1),
  // Client-generated per composer, carried across retries of the SAME attempt: the database makes it exactly-once.
  idempotencyKey: z.string().uuid(),
});
export type CommitPredictionInput = z.infer<typeof commitPredictionSchema>;

// Brohda 2.1: a team Pick on its own (Confidence is optional and attached separately). Same exactly-once key discipline as a commitment.
export const setPickSchema = z.object({
  marketId: z.string().uuid(),
  selectedOutcome: z.enum(["YES", "NO"]),
  idempotencyKey: z.string().uuid(),
});
export type SetPickActionInput = z.infer<typeof setPickSchema>;

// Attaching Confidence to the Member's existing Pick on a Market. The Pick is resolved on the server from the signed-in Member and the Market, never taken from the client.
export const attachConfidenceSchema = z.object({
  marketId: z.string().uuid(),
  amount: z.number().int().min(1),
  idempotencyKey: z.string().uuid(),
});
export type AttachConfidenceActionInput = z.infer<typeof attachConfidenceSchema>;
