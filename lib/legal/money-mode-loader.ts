import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isConsumerMonetaryEnabled } from "@/lib/monetary/capability";
import { deriveLegalMoneyMode, type LegalMoneyMode } from "./money-mode";

// Tables whose mere existence of a row means Brohda holds financial records about someone: the wallet ledger, balances, offers, Positions and
// withdrawal / deposit requests. The ledger is append-only, so once any of these has a row the answer never flips back to "none".
const FINANCIAL_RECORD_TABLES = ["wallet_transactions", "wallet_requests", "monetary_positions", "monetary_proposals"] as const;

/** True / false when known; null when it could not be read (the caller then keeps the disclosure). */
export async function hasFinancialRecords(): Promise<boolean | null> {
  try {
    const admin = createAdminClient();
    const results = await Promise.all([
      ...FINANCIAL_RECORD_TABLES.map((table) => admin.from(table).select("id").limit(1)),
      admin.from("wallet_balances").select("id").eq("account_type", "user").gt("balance", 0).limit(1),
    ]);
    if (results.some((r) => r.error)) return null;
    return results.some((r) => (r.data ?? []).length > 0);
  } catch {
    return null;
  }
}

export interface LegalMoneyModeDeps {
  isEnabled?: () => Promise<boolean>;
  hasRecords?: () => Promise<boolean | null>;
}

/** The mode the legal pages render in right now. Both reads can fail; neither failure can produce an inaccurate page (see money-mode.ts). */
export async function loadLegalMoneyMode(deps: LegalMoneyModeDeps = {}): Promise<LegalMoneyMode> {
  const isEnabled = deps.isEnabled ?? isConsumerMonetaryEnabled; // already fails closed
  const hasRecords = deps.hasRecords ?? hasFinancialRecords;
  const flagEnabled = await isEnabled().catch(() => false);
  if (flagEnabled) return "active"; // no need to look at records
  return deriveLegalMoneyMode({ flagEnabled, retainsFinancialRecords: await hasRecords().catch(() => null) });
}
