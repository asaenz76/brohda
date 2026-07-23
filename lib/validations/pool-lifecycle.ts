import { z } from "zod";

// Admin cancelling a pool outright — from DRAFT/OPEN/LOCKED/AWAITING_RESULT,
// not READY_FOR_REVIEW which already has its own dedicated refund flow
// (SettlementReviewForm). Always super_admin-only: it moves money.
export const cancelPoolSchema = z
  .object({
    poolId: z.string().uuid(),
    reason: z.string().trim().min(1, "A reason is required."),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type CancelPoolInput = z.infer<typeof cancelPoolSchema>;
