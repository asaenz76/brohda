import { z } from "zod";
import { PAYMENT_METHODS } from "@/lib/payment-methods/constants";

export const walletAdjustmentSchema = z
  .object({
    userId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    reason: z.string().trim().min(1),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type WalletAdjustmentInput = z.infer<typeof walletAdjustmentSchema>;

export const walletRequestSchema = z
  .object({
    type: z.enum(["deposit", "withdrawal"]),
    amountCents: z.number().int().positive(),
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().uuid(),
    // Set only by the "quick top-up" flow on EntryConfirmationSheet's
    // insufficient-balance branch — records which entry this deposit is
    // for, so approveWalletRequestAction can auto-complete it once funds
    // land. Left undefined for every ordinary deposit/withdrawal request.
    intendedPoolId: z.string().uuid().optional(),
    intendedOptionId: z.string().uuid().optional(),
    // All three optional at the schema level, not enforced here — both
    // deposit-mode UIs (WalletRequestForm and TopUpAndJoinModal, via the
    // shared DepositFields component) require paymentMethod and
    // transactionRef via plain HTML `required` on their own inputs instead.
    // Kept optional here so older/partial submissions still parse rather
    // than hard-failing.
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    otherMethodNote: z.string().trim().max(200).optional(),
    transactionRef: z.string().trim().max(200).optional(),
  })
  .strict()
  // Withdrawals repurpose `note` as the payout destination (Venmo username,
  // cashtag, wallet address + network, etc.) — WalletRequestForm makes it a
  // required input for withdrawal mode, enforced here too since that's the
  // only way approveWalletRequestAction can know where to send the funds.
  // Never affects deposits (WalletRequestForm's deposit mode or
  // TopUpAndJoinModal), which stay untouched — withdrawal is the only mode
  // that repurposes `note` this way.
  .refine((data) => data.type !== "withdrawal" || (data.note && data.note.length > 0), {
    message: "Enter where the funds should be sent.",
    path: ["note"],
  });

export type WalletRequestInput = z.infer<typeof walletRequestSchema>;

export const walletRequestReviewSchema = z
  .object({
    requestId: z.string().uuid(),
    adminNote: z.string().trim().max(500).optional(),
  })
  .strict();

export type WalletRequestReviewInput = z.infer<typeof walletRequestReviewSchema>;

// Admin-only: setting the destination (wallet address / username / cashtag
// / email) and instructions shown to players once they pick this method on
// the deposit form. Enable/disable is a separate plain-boolean action, not
// part of this schema.
export const paymentMethodSettingsSchema = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    destination: z.string().trim().max(200).optional(),
    instructions: z.string().trim().max(300).optional(),
  })
  .strict();

export type PaymentMethodSettingsInput = z.infer<typeof paymentMethodSettingsSchema>;
