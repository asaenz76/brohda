/**
 * Brohda's product never names a payment processor. This scans the USER-VISIBLE application source (pages, components, notification/email copy, product
 * libraries) for payment-provider brand names. Provider-specific operational detail may exist ONLY in server adapters, configuration and developer/operator
 * docs — none of which this scans — so an unrelated internal document can never make it fail. The list of names lives here, in a test, and nowhere else.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BRANDS = /\b(onvo|stripe|paypal|paddle|braintree|adyen|mercado ?pago|sinpe(?: m[oó]vil)?|payoneer|lemon ?squeezy|razorpay|mollie|venmo|zelle|cash ?app|apple ?pay|google ?pay|bitpay|coinbase|binance)\b/i;
const ROOTS = ["app", "components", "lib/email", "lib/notifications", "lib/sponsorship", "lib/sponsor", "lib/legal", "lib/rules", "lib/landing"];

// The ONE known exception, and it is not Brohda's processor: the MEMBER wallet's payment-METHOD labels (the apps members themselves pay each other with, off the
// platform — part of the monetary P2P layer, which is out of scope here and currently off). It is listed so any NEW occurrence anywhere else fails this test.
// OWNER DECISION pending on whether to genericize it (see the closure report).
const KNOWN_MEMBER_WALLET_EXCEPTION = new Set(["app/(app)/wallet/wallet-request-form.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|md|mdx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("provider-neutral product copy", () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it("scans a real set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no payment-processor brand appears anywhere a Sponsor, Member or the public can read it", () => {
    const hits = files.filter((f) => !KNOWN_MEMBER_WALLET_EXCEPTION.has(f)).flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i: i + 1, line })).filter((x) => BRANDS.test(x.line)).map((x) => `${x.f}:${x.i}: ${x.line.trim().slice(0, 100)}`));
    expect(hits).toEqual([]);
  });

  it("the exception is exactly the Member wallet form, and nothing Sponsor- or public-facing is in it", () => {
    expect([...KNOWN_MEMBER_WALLET_EXCEPTION]).toEqual(["app/(app)/wallet/wallet-request-form.tsx"]);
    for (const f of KNOWN_MEMBER_WALLET_EXCEPTION) expect(f.startsWith("app/(app)/wallet/")).toBe(true);
  });

  it("the Privacy Policy names no payment app or processor", () => {
    expect(BRANDS.test(readFileSync("components/legal/PrivacyDocument.tsx", "utf8"))).toBe(false);
    expect(BRANDS.test(readFileSync("components/legal/TermsDocument.tsx", "utf8"))).toBe(false);
  });

  it("the sponsorship payment vocabulary stays generic", () => {
    const vocab = readFileSync("lib/sponsorship/format.ts", "utf8");
    for (const generic of ["Refund pending", "Refunded", "Payment failed"]) expect(vocab).toContain(generic);
  });
});
