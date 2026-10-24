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

const SQL = ["supabase/migrations/20260101000201_confidence_foundation.sql", "supabase/migrations/20260101000203_confidence_backed_picks.sql", "supabase/migrations/20260101000204_confidence_stake_status_many.sql", "supabase/migrations/20260101000205_mandatory_confidence_predictions.sql"];
const TS = [...walk("lib/confidence"), "lib/actions/confidence.ts", "lib/actions/confidence-admin.ts", "lib/actions/predictions.ts", "components/predictions/PredictionComposer.tsx", ...walk("components/confidence"), "app/(app)/profile/confidence/page.tsx", "app/(admin)/admin/confidence/page.tsx"];

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

  it("Call BS has no Confidence economics: nothing in the domain reads, writes or references a Call BS challenge", () => {
    for (const file of TS) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/lib\/challenges|accept_call_bs|acceptCallBS|callBS/);
    }
    for (const file of SQL) expect(code(file), file).not.toMatch(/\bchallenges\b|\bchallenge_/);
  });

  it("the Pick coupling is narrow: only the attach/status/settlement code reads Picks, and grading itself is never reimplemented here", () => {
    for (const file of TS) {
      // Brohda 2.1 (M1) deliberately lets a team Pick exist without Confidence, so the ONE server-action file that makes a Pick (setPickAction) may use the repository's setPick. Nothing else in the domain may, and
      // nothing at all may reimplement or call grading/streak code.
      const allowed = file === "lib/actions/predictions.ts";
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/lib\/predictions\/(grading|streak)|runGradingJob|markPredictionGraded/);
      if (!allowed) expect(text, file).not.toMatch(/lib\/predictions\/repository|set_pick/);
    }
    // Settlement is driven by the canonical grade (the PENDING -> GRADED transition), never by anything the Member or a client supplies.
    const migration = readFileSync(join(ROOT, SQL[1]), "utf8");
    expect(migration).toMatch(/after update of lifecycle_state on public\.predictions/);
    expect(code(SQL[1])).not.toMatch(/p_result|p_outcome/);
  });

  it("the shell balance indicator reads the Confidence domain only: no wallet, currency or payment coupling", () => {
    for (const file of ["components/confidence/ConfidenceBalance.tsx", "components/predictions/PredictionComposer.tsx", "lib/confidence/stakes.ts", "lib/confidence/offer.ts"]) {
      const raw = readFileSync(join(ROOT, file), "utf8");
      expect(code(file), file).not.toMatch(/wallet|currency|payment|\$\{?\s*amount|sponsor/i);
      for (const i of raw.match(/from\s+["']([^"']+)["']/g) ?? []) expect(i, `${file}: ${i}`).not.toMatch(/wallet|monetary|payments|onvo|lemon|sponsorship/i);
    }
  });

  it("an amount behind a Pick is a whole number from the configured ladder: no odds, fee, payout or stake multiplier exists in code or schema", () => {
    for (const file of [SQL[1], SQL[3], "lib/confidence/stakes.ts", "lib/confidence/predictions.ts", "lib/actions/predictions.ts", "components/predictions/PredictionComposer.tsx"]) {
      expect(code(file), file).not.toMatch(/\b(odds|multiplier|payout|fee|fees|rake|commission|leverage|boost)\b/i);
    }
  });
});
