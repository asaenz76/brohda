import { z } from "zod";

// Milestone R7. The only client-supplied identifier for creation is the
// recipient's Pick id (§9) — challenger identity/Pick/Market/selection are
// always server-derived, never accepted here.

export const callBsSchema = z
  .object({
    recipientPredictionId: z.string().uuid(),
  })
  .strict();

export type CallBsInput = z.infer<typeof callBsSchema>;

export const respondToChallengeSchema = z
  .object({
    challengeId: z.string().uuid(),
  })
  .strict();

export type RespondToChallengeInput = z.infer<typeof respondToChallengeSchema>;
