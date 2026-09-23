import { z } from "zod";

// Prediction submission input validation — mirrors this codebase's existing
// convention (lib/validations/discovery.ts, lib/validations/pools.ts).

export const submitPredictionSchema = z.object({
  marketId: z.string().uuid(),
  selectedOutcome: z.enum(["YES", "NO"]),
  // Client-generated, carried across retries — see
  // lib/predictions/repository.ts's createPrediction and
  // docs/architecture/prediction-layer.md's mutation-safety section.
  idempotencyKey: z.string().uuid(),
});
export type SubmitPredictionInput = z.infer<typeof submitPredictionSchema>;
