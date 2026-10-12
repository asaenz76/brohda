/**
 * The Member legal/policy pages' money mode against the real database: it follows the ONE canonical consumer capability (monetary_p2p_enabled) and nothing else. Money OFF means
 * "free" — no Member-money copy — regardless of any financial records held internally (the wallet ledger is append-only and shared across files, so a "no records ever" database
 * can't be produced here; that no longer matters, because records have no influence on what is published). The unreadable-setting branch is exercised with injected failures
 * here and in tests/unit/legal-money-gating.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";
import { loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";
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

  it("money OFF with a wallet ledger entry on file -> STILL free: financial records are kept internally, but nothing about Member money is published", async () => {
    const user = await seedUser("legalmoney");
    const { error } = await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: user, p_type: "manual_deposit", p_direction: "credit", p_amount: 500, p_admin_id: null, p_reason: "test", p_idempotency_key: `legal-money-${Date.now()}` });
    expect(error).toBeNull();
    const { count } = await admin.from("wallet_transactions").select("id", { count: "exact", head: true }).eq("user_id", user);
    expect(count).toBeGreaterThan(0); // the record exists…
    await setMoney(false);
    expect(await loadLegalMoneyMode()).toBe("free"); // …and has no influence on what the public pages say
    const rules = await getRulesPolicy();
    expect(rules.monetaryEnabled).toBe(false);
  });

  it("LIVE TOGGLE, no deploy and no source edit: OFF → free, ON → active (money sections available), OFF again → free — with the rules policy following in lockstep", async () => {
    const seen: Array<[string, boolean | null]> = [];
    for (const enabled of [false, true, false]) {
      await setMoney(enabled);
      seen.push([await loadLegalMoneyMode(), (await getRulesPolicy()).monetaryEnabled]);
    }
    expect(seen).toEqual([["free", false], ["active", true], ["free", false]]);
  });

  it("flipping the one setting flips the mode both ways, with nothing else changing", async () => {
    await setMoney(false);
    const off = await loadLegalMoneyMode();
    await setMoney(true);
    const on = await loadLegalMoneyMode();
    await setMoney(false);
    expect([off, on]).toEqual(["free", "active"]);
  });

  it("a malformed stored value can't be stored at all (the column is boolean) and an unreadable setting reads as OFF", async () => {
    expect((await admin.from("platform_settings").update({ monetary_p2p_enabled: "maybe" as never }).eq("id", true)).error).not.toBeNull();
    expect(await loadLegalMoneyMode({ isEnabled: async () => { throw new Error("db down"); } })).toBe("free");
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
