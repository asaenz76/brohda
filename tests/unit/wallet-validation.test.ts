import { describe, expect, it } from "vitest";
import {
  walletAdjustmentSchema,
  walletRequestSchema,
  paymentMethodSettingsSchema,
} from "@/lib/validations/wallet";

const valid = {
  userId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  amountCents: 1000,
  reason: "Venmo reimbursement",
  idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
};

describe("walletAdjustmentSchema", () => {
  it("accepts a fully valid payload", () => {
    expect(walletAdjustmentSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a non-uuid userId", () => {
    expect(walletAdjustmentSchema.safeParse({ ...valid, userId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("rejects a zero or negative amount", () => {
    expect(walletAdjustmentSchema.safeParse({ ...valid, amountCents: 0 }).success).toBe(false);
    expect(walletAdjustmentSchema.safeParse({ ...valid, amountCents: -100 }).success).toBe(false);
  });

  it("rejects a non-integer amount", () => {
    expect(walletAdjustmentSchema.safeParse({ ...valid, amountCents: 10.5 }).success).toBe(false);
  });

  it("rejects an empty reason", () => {
    expect(walletAdjustmentSchema.safeParse({ ...valid, reason: "   " }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(walletAdjustmentSchema.safeParse({ ...valid, extra: "nope" }).success).toBe(false);
  });
});

describe("walletRequestSchema", () => {
  const validDeposit = {
    type: "deposit" as const,
    amountCents: 1000,
    idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    paymentMethod: "USDT" as const,
    transactionRef: "0xabc123",
  };

  it("accepts a fully valid deposit payload", () => {
    expect(walletRequestSchema.safeParse(validDeposit).success).toBe(true);
  });

  // paymentMethod/transactionRef are enforced by the deposit forms'
  // (WalletRequestForm and TopUpAndJoinModal, both via the shared
  // DepositFields component) own `required` HTML attributes, not by this
  // schema — so a payload omitting them must still parse here.
  it("accepts a payload with none of the new payment fields", () => {
    const { paymentMethod, transactionRef, ...minimal } = validDeposit;
    void paymentMethod;
    void transactionRef;
    expect(walletRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts an OTHER payment method with no otherMethodNote (UI-level, not schema-level, enforcement)", () => {
    expect(
      walletRequestSchema.safeParse({ ...validDeposit, paymentMethod: "OTHER" }).success,
    ).toBe(true);
  });

  it("rejects an invalid paymentMethod value", () => {
    expect(
      walletRequestSchema.safeParse({ ...validDeposit, paymentMethod: "BITCOIN" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(walletRequestSchema.safeParse({ ...validDeposit, extra: "nope" }).success).toBe(false);
  });

  // Withdrawals repurpose `note` as the payout destination (Venmo username,
  // wallet address, cashtag, etc.) — WalletRequestForm makes it a required
  // HTML input for withdrawal mode, and this schema-level refine backstops
  // that for the server action itself.
  it("accepts a withdrawal with a note (the payout destination)", () => {
    expect(
      walletRequestSchema.safeParse({
        type: "withdrawal",
        amountCents: 1000,
        idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        paymentMethod: "VENMO",
        note: "@janedoe",
      }).success,
    ).toBe(true);
  });

  it("rejects a withdrawal with no note", () => {
    expect(
      walletRequestSchema.safeParse({
        type: "withdrawal",
        amountCents: 1000,
        idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        paymentMethod: "VENMO",
      }).success,
    ).toBe(false);
  });

  it("rejects a withdrawal with a blank/whitespace-only note", () => {
    expect(
      walletRequestSchema.safeParse({
        type: "withdrawal",
        amountCents: 1000,
        idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        paymentMethod: "VENMO",
        note: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("paymentMethodSettingsSchema", () => {
  it("accepts a method with destination and instructions", () => {
    expect(
      paymentMethodSettingsSchema.safeParse({
        method: "USDT",
        destination: "0xAbc123",
        instructions: "on the ETH Network",
      }).success,
    ).toBe(true);
  });

  it("accepts a method with no destination/instructions set yet", () => {
    expect(paymentMethodSettingsSchema.safeParse({ method: "VENMO" }).success).toBe(true);
  });

  it("rejects an unknown method", () => {
    expect(paymentMethodSettingsSchema.safeParse({ method: "BITCOIN" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      paymentMethodSettingsSchema.safeParse({ method: "USDT", extra: "nope" }).success,
    ).toBe(false);
  });
});
