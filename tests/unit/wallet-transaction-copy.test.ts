import { describe, expect, it } from "vitest";
import { walletTransactionLabel } from "@/lib/wallet/transaction-copy";

describe("walletTransactionLabel", () => {
  it("returns plain text with no underscores for every known wallet_transaction_type", () => {
    const types = [
      "manual_deposit",
      "manual_withdrawal",
      "pool_entry_debit",
      "pool_payout_credit",
      "pool_refund_credit",
      "admin_adjustment_credit",
      "admin_adjustment_debit",
      "settlement_reversal_debit",
      "settlement_reversal_credit",
      "house_fee_credit",
      "rounding_remainder_credit",
    ];

    for (const type of types) {
      const label = walletTransactionLabel(type);
      expect(label).not.toContain("_");
      expect(label).not.toBe(type);
    }
  });

  it("matches the exact copy the user reported was leaking raw", () => {
    expect(walletTransactionLabel("settlement_reversal_debit")).toBe("Settlement reversal debit");
  });

  it("falls back to a humanized label for an unmapped type instead of the raw value", () => {
    expect(walletTransactionLabel("some_future_type")).toBe("Some future type");
  });
});
