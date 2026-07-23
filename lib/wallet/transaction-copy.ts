import { humanizeEnum } from "@/lib/utils/humanize";

// Single source of truth for every wallet_transaction_type's display
// label — shared by the player-facing Activity ledger and the admin
// house-revenue view so the two can't drift into covering different
// subsets of the enum (which is exactly how "settlement_reversal_debit"
// used to leak through raw, with an underscore, on a real user's screen).
const WALLET_TRANSACTION_COPY: Record<string, string> = {
  manual_deposit: "Admin added funds to your balance",
  manual_withdrawal: "Admin withdrew funds from your balance",
  pool_entry_debit: "Entered a pool",
  pool_payout_credit: "Pool payout",
  pool_refund_credit: "Pool refund",
  admin_adjustment_credit: "Admin balance adjustment",
  admin_adjustment_debit: "Admin balance adjustment",
  settlement_reversal_debit: "Settlement reversal debit",
  settlement_reversal_credit: "Settlement reversal credit",
  house_fee_credit: "Coordinator fee collected",
  rounding_remainder_credit: "Rounding remainder retained",
};

/** Falls back to a humanized version of the raw type for anything not
 *  (yet) in the map above, instead of ever showing the raw enum value. */
export function walletTransactionLabel(type: string): string {
  return WALLET_TRANSACTION_COPY[type] ?? humanizeEnum(type);
}
