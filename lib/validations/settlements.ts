import { z } from "zod";

export const confirmSettlementSchema = z
  .object({
    poolId: z.string().uuid(),
    gradingVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    // Only required/used when the settlement's requires_manual_verification
    // flag is set (spec §16.3's ambiguous-result path).
    winningOptionId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type ConfirmSettlementInput = z.infer<typeof confirmSettlementSchema>;

// The admin-confirmed refund path only ever covers §16.8's no-winner/
// all-winner cases — MINIMUM_ENTRIES_NOT_REACHED and the X.7 anomaly
// reasons are fully automatic (lib/pools/lock.ts / settle.ts), never
// submitted through this action.
export const confirmPoolRefundSchema = z
  .object({
    poolId: z.string().uuid(),
    gradingVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    voidReason: z.enum(["NO_WINNING_ENTRIES", "ALL_ENTRIES_WINNING"]),
  })
  .strict();

export type ConfirmPoolRefundInput = z.infer<typeof confirmPoolRefundSchema>;

// COMBO's confirm step never takes a winningOptionId from the client — it's
// already been stamped onto the settlement row by gradeComboLegsAction (or
// there isn't one, for a Did Not Play void), and confirmComboSettlementAction
// re-reads both that and the leg states fresh rather than trusting anything
// submitted here.
export const confirmComboSettlementSchema = z
  .object({
    poolId: z.string().uuid(),
    gradingVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type ConfirmComboSettlementInput = z.infer<typeof confirmComboSettlementSchema>;

// Same shape/reasoning as confirmComboSettlementSchema — a TEMPLATE_GRADED
// pool's winning option is already stamped by gradeTemplatePool, so this
// confirm step never takes a winningOptionId from the client either.
export const confirmTemplateSettlementSchema = z
  .object({
    poolId: z.string().uuid(),
    gradingVersion: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type ConfirmTemplateSettlementInput = z.infer<typeof confirmTemplateSettlementSchema>;
