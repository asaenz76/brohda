import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for the permanent product rules of the Confidence domain: it is NOT money. It cannot be purchased, redeemed or transferred, has no cash value and no payment-provider dependency, and it does
// not share terminology or code with the Member wallet / monetary P2P / payment systems — so those can be deleted later without touching it. These read the actual source, so a future change that couples them
// fails here.

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });

/** The source with comments and quoted strings removed, so what remains is identifiers, imports and SQL names. */
function code(path: string): string {
  const raw = readFileSync(join(ROOT, path), "utf8");
  if (path.endsWith(".sql")) {
    return raw.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
  }
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}
/** Text a Member or admin reads (JSX text and string literals), with comments removed. */
function copy(path: string): string {
  return readFileSync(join(ROOT, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SQL = ["supabase/migrations/20260101000201_confidence_foundation.sql"];
const TS = [...walk("lib/confidence"), "lib/actions/confidence.ts", "lib/actions/confidence-admin.ts", ...walk("components/confidence"), "app/(app)/profile/confidence/page.tsx", "app/(admin)/admin/confidence/page.tsx"];

describe("the Confidence domain is not money", () => {
  it("imports nothing from the wallet, monetary, payment or sponsorship code", () => {
    for (const file of TS) {
      const imports = code(file).match(/from\s+["'][^"']+["']/g) ?? [];
      // quoted strings are blanked above, so read imports from the raw text
      const rawImports = readFileSync(join(ROOT, file), "utf8").match(/from\s+["']([^"']+)["']/g) ?? [];
      for (const i of rawImports) expect(i, `${file}: ${i}`).not.toMatch(/wallet|monetary|payments|payment-methods|onvo|lemon|sponsorship|sponsor-intelligence|reputation\/.*money/i);
      expect(imports.length >= 0).toBe(true);
    }
  });

  it("the schema references no wallet, monetary, payment or provider table or function", () => {
    for (const file of SQL) {
      expect(code(file), file).not.toMatch(/wallet|monetary|commercial_payment|payment|onvo|lemon|usdt|stablecoin|apply_wallet_transaction|sponsorship/i);
    }
  });

  it("has no transfer, redemption, purchase or price vocabulary anywhere in its identifiers", () => {
    for (const file of [...SQL, ...TS]) {
      expect(code(file), file).not.toMatch(/\b(transfer\w*|redeem\w*|redemption|purchase\w*|checkout|recipient\w*|gift\w*|marketplace|cash\w*|payout|bankroll|currency|price|usd|exchange_rate|withdraw\w*)\b/i);
    }
  });

  it("uses the Confidence vocabulary: no Cred / Gold / coin / chip / token / wallet names in the new domain", () => {
    for (const file of [...SQL, ...TS]) {
      expect(code(file), file).not.toMatch(/\b(cred|credits?|gold|coins?|chips?|tokens?|wallet)\b/i);
    }
  });

  it("what Members and admins read never uses betting or money language", () => {
    for (const file of TS.filter((f) => f.endsWith(".tsx"))) {
      expect(copy(file), file).not.toMatch(/\b(bet|bets|betting|wager|wagers|odds|payout|wallet|buy|purchase|top[- ]?up|cred|gold|coins?|cash|dollars?|usd|usdt|funds)\b/i);
    }
  });

  it("no Confidence-specific purchase, checkout or recovery-payment capability exists in settings or code", () => {
    const registry = readFileSync(join(ROOT, "lib/admin-settings/registry.ts"), "utf8");
    expect(registry).not.toMatch(/confidence_recovery|confidence_purchase|recover_confidence|confidence_checkout/i);
    const everything = walk("lib").concat(walk("app"), walk("components"));
    for (const file of everything) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/confidence_recovery|confidence_purchase|recoverConfidence|buyConfidence|confidenceCheckout/);
    }
  });

  it("does not touch Picks, Call BS or grading yet", () => {
    for (const file of TS) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/lib\/predictions|lib\/challenges|set_pick|accept_call_bs|grading/);
    }
    expect(code(SQL[0])).not.toMatch(/\bpredictions\b|\bchallenges\b/);
  });
});
