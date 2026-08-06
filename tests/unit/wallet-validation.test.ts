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
    transactionRef: "0x" + "a".repeat(64),
  };

  it("accepts a fully valid deposit payload", () => {
    expect(walletRequestSchema.safeParse(validDeposit).success).toBe(true);
  });

  // paymentMethod is enforced by the deposit forms' (WalletRequestForm and
  // TopUpAndJoinModal, both via the shared DepositFields component) own
  // `required` HTML attribute, not by this schema — the payment-reference
  // superRefine below only runs once a paymentMethod is present, so a
  // payload omitting both must still parse here.
  it("accepts a payload with none of the new payment fields", () => {
    const { paymentMethod, transactionRef, ...minimal } = validDeposit;
    void paymentMethod;
    void transactionRef;
    expect(walletRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts an OTHER payment method with no otherMethodNote (UI-level, not schema-level, enforcement)", () => {
    expect(
      walletRequestSchema.safeParse({ ...validDeposit, paymentMethod: "OTHER", transactionRef: undefined })
        .success,
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

// Brohda's review is entirely manual (no on-chain lookup or provider
// webhook for any rail) — how strictly transactionRef is required tracks
// what each rail actually, reliably hands the sender: a crypto tx hash is
// verifiable evidence and format-checked; Venmo/Cash App/Zelle each hand
// the sender a confirmation number, so it's required but not format-
// checked; OTHER has no predictable receipt shape, so it stays optional.
describe("walletRequestSchema — payment reference by method", () => {
  const VALID_EVM_HASH = "0x" + "a".repeat(64);
  const VALID_BARE_HEX_HASH = "b".repeat(64);
  const VALID_SOLANA_SIG = "5J".repeat(30); // 60 base58 chars

  const base = {
    type: "deposit" as const,
    amountCents: 1000,
    idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  };

  it("accepts a crypto deposit with a valid 0x-prefixed transaction hash", () => {
    expect(
      walletRequestSchema.safeParse({ ...base, paymentMethod: "USDC", transactionRef: VALID_EVM_HASH })
        .success,
    ).toBe(true);
  });

  it("accepts a crypto deposit with a valid bare-hex transaction hash", () => {
    expect(
      walletRequestSchema.safeParse({
        ...base,
        paymentMethod: "USDT",
        transactionRef: VALID_BARE_HEX_HASH,
      }).success,
    ).toBe(true);
  });

  it("accepts a crypto deposit with a valid base58 (Solana-style) signature", () => {
    expect(
      walletRequestSchema.safeParse({ ...base, paymentMethod: "USDC", transactionRef: VALID_SOLANA_SIG })
        .success,
    ).toBe(true);
  });

  it("rejects a crypto deposit with a missing transaction hash", () => {
    const result = walletRequestSchema.safeParse({ ...base, paymentMethod: "USDT" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["transactionRef"]);
      expect(result.error.issues[0].message).toMatch(/transaction hash/i);
    }
  });

  it("rejects a crypto deposit with an obviously fake transaction hash", () => {
    const result = walletRequestSchema.safeParse({
      ...base,
      paymentMethod: "USDT",
      transactionRef: "sent it!",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["transactionRef"]);
      expect(result.error.issues[0].message).toMatch(/valid transaction hash/i);
    }
  });

  it("rejects a crypto deposit with a hash that's the wrong length", () => {
    expect(
      walletRequestSchema.safeParse({
        ...base,
        paymentMethod: "USDT",
        transactionRef: "0x" + "a".repeat(63),
      }).success,
    ).toBe(false);
  });

  it.each(["VENMO", "CASHAPP", "ZELLE"] as const)(
    "accepts a %s deposit with any non-empty confirmation number",
    (method) => {
      expect(
        walletRequestSchema.safeParse({ ...base, paymentMethod: method, transactionRef: "ABC123456" })
          .success,
      ).toBe(true);
    },
  );

  it.each(["VENMO", "CASHAPP", "ZELLE"] as const)(
    "rejects a %s deposit with a missing confirmation number",
    (method) => {
      const result = walletRequestSchema.safeParse({ ...base, paymentMethod: method });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["transactionRef"]);
        expect(result.error.issues[0].message).toMatch(/confirmation number/i);
      }
    },
  );

  it("accepts an eligible non-crypto (OTHER) deposit with no reference at all", () => {
    expect(walletRequestSchema.safeParse({ ...base, paymentMethod: "OTHER" }).success).toBe(true);
  });

  it("ignores payment-reference requirements entirely for withdrawals", () => {
    // transactionRef isn't even collected for withdrawals (DepositFields
    // never renders that input outside deposit mode) — a withdrawal with a
    // crypto paymentMethod and no transactionRef must still be valid.
    expect(
      walletRequestSchema.safeParse({
        type: "withdrawal",
        amountCents: 1000,
        idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        paymentMethod: "USDT",
        note: "0xDestinationWallet",
      }).success,
    ).toBe(true);
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
