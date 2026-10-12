/**
 * Rendered-content regression for the PUBLIC Member legal/policy pages (/terms, /rules, /privacy), in both capability states. Targeted assertions against the concepts the owner
 * named — not a blind substring list — plus a classified allow-list for the few generic sentences that legitimately use the word "money" or "fee".
 *
 *   monetary_p2p_enabled = false  →  no Member-money language: no wallet, Position, wager, bet, bookmaker/escrow, stake, deposit, withdrawal, settlement, monetary/P2P, fee on a
 *                                    Position, payment-app handle, historical-records disclosure. Call BS is stated as free.
 *   monetary_p2p_enabled = true   →  the approved money sections render (actual sections, not just a 200).
 *
 * Sponsor surfaces are a different product domain and are NOT scanned for the Member rule; they are asserted to be unaffected.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TermsDocument } from "@/components/legal/TermsDocument";
import { PrivacyDocument } from "@/components/legal/PrivacyDocument";
import { SponsorTermsDocument } from "@/components/legal/SponsorTermsDocument";
import { RulesContent } from "@/components/rules/RulesContent";
import { rulesMetaDescription, UNKNOWN_RULES_POLICY, type RulesPolicy } from "@/lib/rules/format";
import { loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";

vi.mock("server-only", () => ({}));
afterEach(() => cleanup());

const RULES_OFF: RulesPolicy = { ...UNKNOWN_RULES_POLICY, lockMinutesBeforeKickoff: 10, feeBps: 1000, minStakeCents: 500, maxStakeCents: 50000, monetaryEnabled: false, callBsEnabled: true };
const RULES_ON: RulesPolicy = { ...RULES_OFF, monetaryEnabled: true };

// What may NOT appear in a Member-facing page while Member monetary P2P is off.
const FORBIDDEN: Array<[string, RegExp]> = [
  ["wallet", /\bwallets?\b/i],
  ["Position (a money Position)", /\bPositions?\b|money position/],
  ["wager / bet / betting", /\bwagers?\b|\bbets?\b|\bbetting\b/i],
  ["bookmaker / gambling / escrow / money transmitter", /bookmaker|gambling|escrow|money transmitter/i],
  ["stake", /\bstak(?:e|es|ed|ing)\b/i],
  ["deposit", /\bdeposits?\b/i],
  ["withdrawal", /\bwithdraw\w*/i],
  ["settlement of money", /\bsettle(?:s|d|ment|ments)?\b/i],
  ["monetary / P2P", /monetary|\bP2P\b|peer-to-peer/i],
  ["balance / ledger / payout / funds", /\bbalances?\b|\bledger\b|\bpayouts?\b|\bfunds?\b|\bfunding\b/i],
  ["platform / service fee", /platform fee|service fee/i],
  ["payment app / method", /payment app|payment method|payment-app/i],
  ["named payment apps and tokens", /venmo|cash ?app|zelle|usdt|usdc|crypto/i],
  ["historical money records", /financial records|money records|earlier activity/i],
];

// Sentences that legitimately contain a word from the lists above WITHOUT describing Member money. Each is classified; anything else is a failure.
const ALLOWED_GENERIC: Array<[string, RegExp]> = [
  ["conduct rule: money laundering / fraud (generic anti-abuse, not a Member feature)", /money laundering/gi],
  ["boilerplate damages type in the limitation of liability", /loss of money, data, or goodwill/gi],
  ["attorneys' fees in the indemnity (legal costs, not a fee on anything)", /attorneys(?:'|’)\s*fees/gi],
  ["the Market type named Moneyline", /Moneyline/gi],
];
const MONEY_WORD = /\bmoney\b|\bfees?\b/i;

const norm = (el: React.ReactElement) => {
  const { container, unmount } = render(el);
  const out = (container.textContent ?? "").replace(/\s+/g, " ");
  const sections: Array<{ title: string; text: string }> = [];
  container.querySelectorAll("section").forEach((sec) => sections.push({ title: (sec.querySelector("h2")?.textContent ?? "").replace(/^\d+\.\s*/, "").trim(), text: (sec.textContent ?? "").replace(/\s+/g, " ") }));
  const headings = [...container.querySelectorAll("h2")].map((h) => (h.textContent ?? "").trim());
  unmount();
  return { text: out, sections, headings };
};

/** Member-facing text only: the Sponsor section of the Privacy Policy is a separate, clearly headed domain and is checked separately. */
const memberText = (page: ReturnType<typeof norm>) => page.sections.filter((s) => s.title !== "Sponsor accounts and sponsorships").map((s) => s.text).join(" ");
const stripAllowed = (t: string) => ALLOWED_GENERIC.reduce((acc, [, re]) => acc.replace(re, " "), t);

describe("monetary P2P OFF — the three public Member pages carry no Member-money language", () => {
  const terms = norm(<TermsDocument mode="free" />);
  const privacy = norm(<PrivacyDocument mode="free" />);
  const rulesText = norm(<RulesContent policy={RULES_OFF} />).text;

  it.each(FORBIDDEN)("/terms has no %s", (_name, re) => {
    expect(stripAllowed(terms.text)).not.toMatch(re);
  });
  it.each(FORBIDDEN)("/privacy (Member sections) has no %s", (_name, re) => {
    expect(stripAllowed(memberText(privacy))).not.toMatch(re);
  });
  it.each(FORBIDDEN)("/rules has no %s", (_name, re) => {
    expect(stripAllowed(rulesText)).not.toMatch(re);
  });

  it("every remaining 'money' / 'fee' word on the three pages is one of the classified generic sentences", () => {
    for (const [name, t] of [["terms", terms.text], ["privacy", memberText(privacy)], ["rules", rulesText]] as const) expect(stripAllowed(t), name).not.toMatch(MONEY_WORD);
  });

  it("Terms: the product is described as the prediction network it is, with no dormant financial functionality", () => {
    expect(terms.text).toContain("brohda. is a social network built around real sporting events.");
    expect(terms.text).toMatch(/members make Picks on them, comment, and can challenge one another with .?Call BS/);
    expect(terms.text).not.toMatch(/Where it is enabled, the Service also lets/);
  });

  it("Terms: the Member-bet classification disclaimer is gone, and the headings are consecutively numbered with no gap and no dangling 'Section N'", () => {
    expect(terms.text).not.toContain("party to any wager, bet, or contest between members");
    const nums = terms.headings.map((h) => Number(h.split(".")[0]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    for (const m of terms.text.matchAll(/Section (\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(nums.length);
    expect(terms.headings.join("|")).not.toMatch(/fee|wallet|deposit|withdraw|retained/i);
  });

  it("Privacy: no Member financial-data disclosure at all; the headings are consecutively numbered", () => {
    expect(privacy.headings.join("|")).not.toMatch(/financial|wallet|money/i);
    const nums = privacy.headings.map((h) => Number(h.split(".")[0]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    expect(memberText(privacy)).toContain("We do not collect government identification.");
  });

  it("Rules: no Money section, and Call BS is stated as free (it is the only head-to-head challenge left)", () => {
    const page = norm(<RulesContent policy={RULES_OFF} />);
    expect(page.headings.join("|")).not.toMatch(/Money/);
    expect(page.text).toMatch(/Call BS is a free, head-to-head challenge between two people who picked opposite sides of the same Market\./);
    expect(page.text).not.toMatch(/involves no money|no money/i); // "free" says it; money isn't mentioned at all
    // …and with money ON the same sentence is kept and says so explicitly
    expect(norm(<RulesContent policy={RULES_ON} />).text).toMatch(/Call BS is a free, head-to-head challenge[^.]*\. It involves no money\./);
  });

  it("the Rules <meta> description doesn't advertise money either", () => {
    expect(rulesMetaDescription(false)).toBe("A plain explanation of how Brohda works: Picks, Call BS, results.");
    expect(rulesMetaDescription(false)).not.toMatch(/money/i);
  });

  it("an unreadable / malformed setting behaves exactly like OFF on every page", async () => {
    const throwing = async () => {
      throw new Error("settings unreadable");
    };
    const mode = await loadLegalMoneyMode({ isEnabled: throwing });
    expect(mode).toBe("free");
    expect(norm(<TermsDocument mode={mode} />).text).toBe(terms.text);
    expect(norm(<PrivacyDocument mode={mode} />).text).toBe(privacy.text);
    expect(norm(<RulesContent policy={UNKNOWN_RULES_POLICY} />).headings.join("|")).not.toMatch(/Money/);
  });
});

describe("monetary P2P ON — the approved money sections are really there", () => {
  const terms = norm(<TermsDocument mode="active" />);
  const privacy = norm(<PrivacyDocument mode="active" />);
  const rules = norm(<RulesContent policy={RULES_ON} />);

  it("/terms: the money mechanics, deposits and withdrawals, the fee, and the classification disclaimer", () => {
    const h = terms.headings.join("|");
    expect(h).toMatch(/Deposits and withdrawals happen outside the App/);
    expect(h).toMatch(/Service fee/);
    expect(terms.text).toMatch(/optional money Position on opposing Picks/);
    expect(terms.text).toContain("The Company is not a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling operator, or party to any wager, bet, or contest between members.");
  });

  it("/rules: the Money section with the offer, hold, fee and settlement rules (the fee and limits come from the live policy)", () => {
    expect(rules.headings.join("|")).toMatch(/Money/);
    expect(rules.text).toMatch(/You can offer money to someone who picked the opposite side of the same Market/);
    expect(rules.text).toMatch(/The fee is currently 10%/);
  });

  it("/privacy: the wallet and money explanations, and who can see a Position", () => {
    expect(privacy.text).toMatch(/wallet/i);
    expect(privacy.text).toMatch(/Position/);
  });

  it("the Rules <meta> description mentions money only now", () => {
    expect(rulesMetaDescription(true)).toBe("A plain explanation of how Brohda works: Picks, Call BS, results, and optional money between members.");
  });
});

describe("Sponsor commercial legal content is a separate domain — unaffected by the Member capability", () => {
  it("the Sponsor section of the Privacy Policy is present in BOTH states, with its commercial-payment disclosures", () => {
    for (const mode of ["free", "active"] as const) {
      const sponsor = norm(<PrivacyDocument mode={mode} />).sections.find((s) => s.title === "Sponsor accounts and sponsorships");
      expect(sponsor, mode).toBeTruthy();
      expect(sponsor!.text).toMatch(/third-party payment service provider/);
      expect(sponsor!.text).toMatch(/payment reference/);
      expect(sponsor!.text).toMatch(/Sponsors never receive information about individual Members/);
    }
  });

  it("the Sponsor Terms render no differently whatever the Member capability (they take no money mode at all)", () => {
    const a = norm(<SponsorTermsDocument refundCutoffHours={12} />).text;
    const b = norm(<SponsorTermsDocument refundCutoffHours={12} />).text;
    expect(a).toBe(b);
    expect(a).toMatch(/one or more methods, including online through a third-party payment service provider/);
    expect(a).toMatch(/Refunds/);
  });
});

describe("one capability, server-rendered, uncached — enforced at the source", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const PAGES = ["app/terms/page.tsx", "app/privacy/page.tsx", "app/rules/page.tsx"];

  it("each public page is rendered per request (no static/route cache can keep stale money copy)", () => {
    for (const p of PAGES) expect(read(p), p).toMatch(/export const dynamic = "force-dynamic"/);
    for (const p of PAGES) expect(read(p), p).not.toMatch(/revalidate\s*=|unstable_cache|generateStaticParams/);
  });

  it("no page, document or Rules component reads the capability itself or hard-codes visibility — they all go through the shared policy", () => {
    const files = [...PAGES, "components/legal/TermsDocument.tsx", "components/legal/PrivacyDocument.tsx", "components/rules/RulesContent.tsx", "lib/rules/policy.ts"];
    for (const f of files) {
      const src = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/monetary_p2p_enabled|isConsumerMonetaryEnabled|isMonetaryP2pEnabled|process\.env/);
      expect(src, f).not.toMatch(/monetaryEnabled\s*[:=]\s*(true|false)\b/);
    }
    for (const p of ["app/terms/page.tsx", "app/privacy/page.tsx"]) expect(read(p), p).toContain("loadLegalMoneyMode");
    expect(read("lib/rules/policy.ts")).toContain("loadLegalMoneyMode");
  });

  it("money visibility is decided on the server and handed to the document as data — never rendered and hidden with CSS or script", () => {
    for (const f of ["components/legal/TermsDocument.tsx", "components/legal/PrivacyDocument.tsx", "components/rules/RulesContent.tsx"]) {
      const src = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/"use client"/);
      expect(src, f).not.toMatch(/\bhidden\b|display:\s*none|sr-only|\bclassName=\{?["'][^"']*\binvisible\b/);
    }
  });
});
