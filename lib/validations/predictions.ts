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
