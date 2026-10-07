/**
 * Rules, Terms and Privacy follow the ONE consumer money capability (monetary_p2p_enabled). Separately, what the legal documents say about
 * financial RECORDS follows the facts, not the flag: with money off, current-feature copy disappears, but anything we still hold for existing or
 * historical users stays disclosed. Three modes (lib/legal/money-mode.ts):
 *   active (money on) · retained (money off, financial records exist or can't be ruled out) · free (money off, nothing financial ever stored).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TermsDocument, termsSectionIds } from "@/components/legal/TermsDocument";
import { PrivacyDocument } from "@/components/legal/PrivacyDocument";
import { RulesContent } from "@/components/rules/RulesContent";
import { UNKNOWN_RULES_POLICY, type RulesPolicy } from "@/lib/rules/format";
import { byMode, deriveLegalMoneyMode, type LegalMoneyMode } from "@/lib/legal/money-mode";
import { loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";

vi.mock("server-only", () => ({}));
afterEach(() => cleanup());

const text = (node: React.ReactElement) => {
  const { container, unmount } = render(node);
  const out = (container.textContent ?? "").replace(/\s+/g, " ");
  unmount();
  return out;
};
const headings = (node: React.ReactElement) => {
  const { container, unmount } = render(node);
  const out = [...container.querySelectorAll("h2")].map((h) => (h.textContent ?? "").trim());
  unmount();
  return out;
};

const RULES_ON: RulesPolicy = { lockMinutesBeforeKickoff: 10, feeBps: 100, minStakeCents: 100, maxStakeCents: 10000, monetaryEnabled: true, callBsEnabled: true };
const RULES_OFF: RulesPolicy = { ...RULES_ON, monetaryEnabled: false };
const MODES: LegalMoneyMode[] = ["active", "retained", "free"];

// Copy that explains the CURRENT optional money feature — must never appear when money is off.
const CURRENT_MONEY_FEATURE = [
  /optional money Position/i,
  /add funds/i,
  /commits part of their wallet balance/i,
  /settles the Position/i,
  /platform fee/i,
  /Service fee/i,
  /Where optional money Positions are enabled/i,
  /Deposits and withdrawals happen outside the App/i,
  /put money on/i,
  /money Position is private/i,
  /Money is private to the people involved/i,
];
// A "coming soon" / disabled-feature explanation about the money layer. (Call BS's own status wording — e.g. "unavailable Call BS" — is not about money.)
const PLACEHOLDER = /coming soon|money[^.]{0,80}(not (currently |yet )?available|unavailable|switched off|turned off|disabled|paused|temporarily|will be available)|(not (currently |yet )?available|unavailable|switched off|turned off|disabled|paused|temporarily|will be available)[^.]{0,80}(money|wallet|Position)/i;

describe("Money ON — the current-product copy is there", () => {
  it("Rules: the money section; Terms: the money mechanics, deposits and withdrawals, the fee; Privacy: who can see a Position", () => {
    const rules = text(<RulesContent policy={RULES_ON} />);
    expect(rules).toContain("Money");
    expect(rules).toContain("You can offer money to someone who picked the opposite side of the same Market");
    const terms = text(<TermsDocument mode="active" />);
    expect(terms).toContain("optional money Position");
    expect(terms).toContain("may add funds to their wallet balance");
    expect(terms).toContain("Deposits and withdrawals happen outside the App");
    expect(terms).toContain("Service fee");
    expect(terms).toContain("The Service may deduct a platform fee as described in Section 5.");
    const privacy = text(<PrivacyDocument mode="active" />);
    expect(privacy).toContain("Money is private to the people involved");
    expect(privacy).toContain("Wallet and money records");
  });
});

describe("Money OFF, clean consumer (no financial data ever stored) — the free social product, no money language", () => {
  const rules = text(<RulesContent policy={RULES_OFF} />);
  const terms = text(<TermsDocument mode="free" />);
  const privacy = text(<PrivacyDocument mode="free" />);

  it("Rules: the money section is absent", () => {
    expect(headings(<RulesContent policy={RULES_OFF} />)).not.toContain("Money");
    expect(rules).not.toMatch(/money Position|offer money|wallet|balance|fee\b/i);
  });

  it("Terms: no current-money copy, no fee, no deposits/withdrawals, no wallet — and the headings are renumbered with no gap", () => {
    for (const pattern of CURRENT_MONEY_FEATURE) expect(terms, String(pattern)).not.toMatch(pattern);
    expect(terms).not.toMatch(/wallet|withdraw|deposit|settle|reserved|ledger|balance|payout|Position/i);
    expect(headings(<TermsDocument mode="free" />).map((h) => h.split(".")[0])).toEqual(Array.from({ length: headings(<TermsDocument mode="free" />).length }, (_, i) => String(i + 1)));
    expect(headings(<TermsDocument mode="free" />)).not.toContain("5. Service fee");
  });

  it("Privacy: no wallet / money / ledger / payout / Position language at all, and no claim about records that do not exist", () => {
    for (const pattern of CURRENT_MONEY_FEATURE) expect(privacy, String(pattern)).not.toMatch(pattern);
    expect(privacy).not.toMatch(/wallet|ledger|payout|withdraw|Position|money records/i);
    expect(privacy).toContain("We do not collect payment card numbers, bank account numbers");
    expect(privacy).toContain("You can close your account from your profile settings.");
  });

  it("no placeholder or coming-soon copy anywhere", () => {
    for (const out of [rules, terms, privacy]) expect(out).not.toMatch(PLACEHOLDER);
  });

  it("the Company's own classification disclaimer is unchanged (it is a legal statement, not feature copy — flagged for counsel in the review doc)", () => {
    expect(terms).toContain("The Company is not a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling operator, or party to any wager, bet, or contest between members.");
  });
});

describe("Money OFF, financial records still exist — current-feature copy gone, required disclosure stays", () => {
  const terms = text(<TermsDocument mode="retained" />);
  const privacy = text(<PrivacyDocument mode="retained" />);
  const rules = text(<RulesContent policy={RULES_OFF} />);

  it("no current-feature money copy in Rules, Terms or Privacy, and no placeholder", () => {
    expect(headings(<RulesContent policy={RULES_OFF} />)).not.toContain("Money");
    for (const out of [terms, privacy]) for (const pattern of CURRENT_MONEY_FEATURE) expect(out, String(pattern)).not.toMatch(pattern);
    for (const out of [rules, terms, privacy]) expect(out).not.toMatch(PLACEHOLDER);
    expect(terms).not.toContain("Deposits and withdrawals happen outside the App");
    expect(headings(<TermsDocument mode="retained" />)).not.toContain("5. Service fee");
  });

  it("Privacy still discloses the financial data held: the wallet ledger, offers and Positions, withdrawal destination, who can see it, permanent retention, and what closing an account keeps", () => {
    expect(privacy).toContain("Wallet and money records");
    expect(privacy).toContain("your wallet ledger entries, any offers and Positions you took part in");
    expect(privacy).toContain("When you request a withdrawal you also enter where you want to be paid");
    expect(privacy).toContain("The payout destination you enter when you request a withdrawal is provided by you");
    expect(privacy).toContain("Wallet and money records are private to the people involved");
    expect(privacy).toContain("Wallet and money-Position records are kept as permanent records of the Service's ledger.");
    expect(privacy).toContain("once your wallet balance is zero and you have no pending wallet requests");
    expect(privacy).toContain("the wallet and money ledger");
  });

  it("Privacy never claims there is no financial data", () => {
    expect(privacy).not.toMatch(/no financial|do not (hold|store|process|retain|keep).{0,40}(financial|wallet|money)|does not (hold|store|process).{0,40}financial/i);
  });

  it("Terms keep the stable obligations: what is kept, how an existing balance is withdrawn, who is responsible for off-platform transfers, administrator authority over the records, and that closing an account does not erase them", () => {
    expect(headings(<TermsDocument mode="retained" />)).toContain("3. Wallet records and withdrawals");
    expect(terms).toContain("The Service keeps the wallet and money records from earlier activity");
    expect(terms).toContain("Where a member still has a balance, a withdrawal is paid by an administrator, after review and confirmation");
    expect(terms).toContain("The Company is not responsible for, and bears no liability for, funds that are lost");
    expect(terms).toContain("Administrators review and approve or reject wallet requests");
    expect(terms).toContain("Closing or ending an account does not erase the wallet records described in Section 3.");
    expect(terms).toContain("any loss arising from an off-platform payment made or received between members");
    expect(terms).toContain("including any dispute over money you sent or received off-platform");
  });

  it("an existing balance can still be recovered — nothing needed to withdraw it is hidden", () => {
    expect(terms).toContain("a withdrawal is paid by an administrator");
    expect(privacy).toContain("wallet requests you submit");
  });
});

describe("Terms as a whole — no sentence points at a hidden section or an undefined concept", () => {
  it.each(MODES)("%s: every 'Section N' reference names an existing section of the right title; headings are 1..n", (mode) => {
    const doc = <TermsDocument mode={mode} />;
    const shown = headings(doc);
    expect(shown.map((h) => Number(h.split(".")[0]))).toEqual(shown.map((_, i) => i + 1));
    const body = text(doc);
    const titleOf = (n: number) => shown[n - 1].replace(/^\d+\.\s*/, "");
    const refs = [...body.matchAll(/(?:see )?Section (\d+)/g)];
    for (const [full, n] of refs) {
      const title = titleOf(Number(n));
      if (/see Section/.test(full) || /as described in Section/.test(body.slice(Math.max(0, (refs.find((r) => r[0] === full)?.index ?? 0) - 30), (refs.find((r) => r[0] === full)?.index ?? 0) + 20))) {
        expect(["Termination", "Service fee", "Wallet records and withdrawals"]).toContain(title);
      }
      expect(Number(n)).toBeLessThanOrEqual(shown.length);
    }
    // The conduct section's pointer always lands on "Termination"; the fee pointer (active) on "Service fee"; the records pointer (retained) on the records section.
    expect(body).toContain(`(see Section ${shown.findIndex((h) => /Termination$/.test(h)) + 1})`);
    if (mode === "active") expect(body).toContain(`as described in Section ${shown.findIndex((h) => /Service fee$/.test(h)) + 1}.`);
    if (mode === "retained") expect(body).toContain(`described in Section ${shown.findIndex((h) => /Wallet records and withdrawals$/.test(h)) + 1}.`);
  });

  it("a section is shown only in the modes that declare it", () => {
    expect(termsSectionIds("active")).toEqual(expect.arrayContaining(["payments", "fee"]));
    expect(termsSectionIds("active")).not.toContain("records");
    expect(termsSectionIds("retained")).toContain("records");
    expect(termsSectionIds("retained")).not.toEqual(expect.arrayContaining(["payments"]));
    expect(termsSectionIds("retained")).not.toContain("fee");
    for (const id of ["payments", "records", "fee"] as const) expect(termsSectionIds("free")).not.toContain(id);
  });
});

describe("the mode decision — one canonical capability, fail-closed", () => {
  it("derive: money on is active; off + records known/unknown is retained; off + known-none is free", () => {
    expect(deriveLegalMoneyMode({ flagEnabled: true, retainsFinancialRecords: false })).toBe("active");
    expect(deriveLegalMoneyMode({ flagEnabled: true, retainsFinancialRecords: null })).toBe("active");
    expect(deriveLegalMoneyMode({ flagEnabled: false, retainsFinancialRecords: true })).toBe("retained");
    expect(deriveLegalMoneyMode({ flagEnabled: false, retainsFinancialRecords: null })).toBe("retained");
    expect(deriveLegalMoneyMode({ flagEnabled: false, retainsFinancialRecords: false })).toBe("free");
  });

  it("SETTING UNREADABLE: consumer money copy fails closed (never 'active'), and the stable disclosure remains whenever records exist or can't be ruled out", async () => {
    expect(deriveLegalMoneyMode({ flagEnabled: null, retainsFinancialRecords: true })).toBe("retained");
    expect(deriveLegalMoneyMode({ flagEnabled: null, retainsFinancialRecords: null })).toBe("retained");
    const throwing = async () => {
      throw new Error("settings unreadable");
    };
    expect(await loadLegalMoneyMode({ isEnabled: throwing, hasRecords: async () => true })).toBe("retained");
    expect(await loadLegalMoneyMode({ isEnabled: throwing, hasRecords: async () => null })).toBe("retained");
    expect(await loadLegalMoneyMode({ isEnabled: throwing, hasRecords: throwing as never })).toBe("retained");
    // unreadable setting but KNOWN no records: nothing to disclose, nothing consumer-facing about money
    expect(await loadLegalMoneyMode({ isEnabled: throwing, hasRecords: async () => false })).toBe("free");
    // Rules uses the same fail-closed reading: an unreadable policy hides the money section
    expect(headings(<RulesContent policy={UNKNOWN_RULES_POLICY} />)).not.toContain("Money");
  });

  it("an unreadable records check never produces 'free' (we do not claim 'no financial data' on a guess)", async () => {
    expect(await loadLegalMoneyMode({ isEnabled: async () => false, hasRecords: async () => null })).toBe("retained");
    expect(await loadLegalMoneyMode({ isEnabled: async () => false, hasRecords: async () => { throw new Error("db down"); } })).toBe("retained");
  });

  it("money ON never even looks at the records", async () => {
    const hasRecords = vi.fn(async () => false);
    expect(await loadLegalMoneyMode({ isEnabled: async () => true, hasRecords })).toBe("active");
    expect(hasRecords).not.toHaveBeenCalled();
  });

  it("byMode requires every mode explicitly (money copy cannot leak into a mode by default)", () => {
    expect(byMode("free", { active: "A", retained: "R", free: "F" })).toBe("F");
    expect(byMode("retained", { active: "A", retained: "R", free: "F" })).toBe("R");
  });
});
