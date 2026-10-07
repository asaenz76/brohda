/**
 * The legal pages' money mode against the real database: it follows the canonical consumer capability (monetary_p2p_enabled) and the FACT of
 * stored financial records. (The setting-unreadable and records-unreadable branches are exercised with injected failures in
 * tests/unit/legal-money-gating.test.tsx; a clean "no financial data ever stored" database cannot be produced here because the wallet ledger is
 * append-only and shared across files.)
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";
import { hasFinancialRecords, loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";
import { isConsumerMonetaryEnabled } from "@/lib/monetary/capability";
import { isMonetaryP2pEnabled } from "@/lib/monetary/policy";
import { getRulesPolicy } from "@/lib/rules/policy";

const admin = getTestAdminClient();
const setMoney = async (enabled: boolean) => {
  const { error } = await admin.from("platform_settings").update({ monetary_p2p_enabled: enabled }).eq("id", true);
  if (error) throw error;
};

describe("legal money mode (database)", () => {
  it("money ON -> active (the current-product copy)", async () => {
    await setMoney(true);
    expect(await loadLegalMoneyMode()).toBe("active");
  });

  it("money OFF with a wallet ledger entry on file -> retained: no current-feature copy, disclosure stays", async () => {
    const user = await seedUser("legalmoney");
    const { error } = await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: user, p_type: "manual_deposit", p_direction: "credit", p_amount: 500, p_admin_id: null, p_reason: "test", p_idempotency_key: randomUUID() });
    expect(error).toBeNull();
    expect(await hasFinancialRecords()).toBe(true);
    await setMoney(false);
    expect(await loadLegalMoneyMode()).toBe("retained");
  });

  it("flipping the one setting flips the mode both ways, with nothing else changing", async () => {
    await setMoney(false);
    const off = await loadLegalMoneyMode();
    await setMoney(true);
    const on = await loadLegalMoneyMode();
    await setMoney(false);
    expect([off, on]).toEqual(["retained", "active"]);
  });

  it("ONE canonical capability: every reader of monetary_p2p_enabled (consumer capability, policy read, Rules, legal mode) agrees after each flip, with no cache between the setting and any page", async () => {
    for (const enabled of [false, true, false, true]) {
      await setMoney(enabled);
      const [capability, policy, rules, mode] = await Promise.all([isConsumerMonetaryEnabled(), isMonetaryP2pEnabled(), getRulesPolicy(), loadLegalMoneyMode()]);
      expect({ capability, policy, rules: rules.monetaryEnabled, active: mode === "active" }).toEqual({ capability: enabled, policy: enabled, rules: enabled, active: enabled });
    }
    await setMoney(false);
  });
});
