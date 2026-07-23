import { z } from "zod";

export const requestReversalSchema = z
  .object({
    poolId: z.string().uuid(),
    reason: z.string().trim().min(1),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type RequestReversalInput = z.infer<typeof requestReversalSchema>;

export const abortReversalSchema = z
  .object({
    poolId: z.string().uuid(),
  })
  .strict();

export type AbortReversalInput = z.infer<typeof abortReversalSchema>;
