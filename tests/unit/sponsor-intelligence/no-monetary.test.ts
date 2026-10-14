import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Sponsor Intelligence measures aggregate attention, participation, prediction behaviour and social engagement around a Sponsored Game. It must NEVER read, carry or show Member
// money: real-money Member P2P is retired as a product direction, and the legacy tables are operational leftovers, not Sponsor analytics. These are static guards over the source,
// so a future change that reaches for a monetary table or term in this domain fails loudly here.

const ROOT = path.resolve(__dirname, "../../..");
const FORBIDDEN_TABLES = /(monetary_|wallet_|commercial_payment|sponsorship_payment|settlement)/i;
const FORBIDDEN_TERMS = /\b(stake|wager|wallet|deposit|withdraw|usdt|payout|bankroll|p2p)\b/i;

function stripComments(source: string): string {
  // SQL line comments, TypeScript line comments and block comments: explanations may NAME what is excluded; only executable code is checked.
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(--|\/\/)[^\n]*/gm, "").replace(/\s(--|\/\/)[^\n]*/g, "");
}

describe("Sponsor Intelligence reads no monetary data", () => {
  it("the aggregate SQL function touches no monetary, wallet, payment or settlement table", () => {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/20260101000196_sponsor_intelligence_foundation.sql"), "utf8");
    const start = sql.indexOf("create or replace function public.sponsor_intelligence_aggregates");
    expect(start).toBeGreaterThan(0);
    const body = stripComments(sql.slice(start));
    expect(body).not.toMatch(FORBIDDEN_TABLES);
    expect(body).not.toMatch(FORBIDDEN_TERMS);
  });

  it("the application code of the domain uses no monetary table or term", () => {
    const dir = path.join(ROOT, "lib/sponsor-intelligence");
    for (const file of readdirSync(dir)) {
      const code = stripComments(readFileSync(path.join(dir, file), "utf8"));
      expect(code, file).not.toMatch(FORBIDDEN_TABLES);
      expect(code, file).not.toMatch(FORBIDDEN_TERMS);
    }
  });
});
