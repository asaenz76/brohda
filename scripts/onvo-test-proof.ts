/**
 * ONVO TEST-API proof — a credentialed, operator-run script that exercises ONVO's REAL TEST environment through Brohda's own adapter. It NEVER runs in CI and refuses to
 * run with anything but a test key. No real money is involved: ONVO's test environment accepts only ONVO's published test payment methods.
 *
 *   put ONVO_SECRET_KEY (onvo_test_secret_key_…), ONVO_WEBHOOK_SECRET and ONVO_ENVIRONMENT=TEST in .env.local, then:
 *     pnpm onvo:test-proof [--refund]
 *
 * What it proves, step by step (each prints PASS/FAIL): the adapter creates a hosted Checkout session for an exact amount; the session URL is yours to open and pay with an
 * ONVO TEST card (e.g. 4242 4242 4242 4242, any future expiry, any CVV); the script then reads the provider's own state and checks the paid amount and currency match
 * what was requested; optionally it issues a TEST refund and confirms the provider's answer. The local-app half of the proof (webhook → PAID → still not live → approval)
 * is covered by the automated suite against the sandbox and by pointing a TEST webhook at a running app (see docs/architecture/commercial-payments.md).
 */
import { OnvoProvider } from "../lib/payments/onvo/adapter";
import { resolveOnvoConfig } from "../lib/payments/config";

const wantRefund = process.argv.includes("--refund");
const step = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const resolved = resolveOnvoConfig(process.env);
  if (!resolved.ok) throw new Error(`ONVO is not configured: ${resolved.reason}`);
  if (resolved.config.environment !== "TEST") throw new Error("Refusing to run: this proof only ever uses a TEST key.");
  const provider = new OnvoProvider(process.env);
  step(provider.availability().state === "test", "configuration resolves to the TEST environment");

  const amountCents = 5000; // $50.00 — the minimum is $0.50
  const checkout = await provider.createPayment({ attemptId: `proof-${Date.now()}`, sponsorshipId: "proof", amountCents, currency: "USD", description: "Brohda test proof", customerEmail: null, successUrl: "https://example.com/success", cancelUrl: "https://example.com/cancel" });
  step(Boolean(checkout.sessionId && checkout.url), "hosted Checkout session created", checkout.sessionId);
  console.log(`\nOpen this URL and pay with ONVO's TEST card 4242 4242 4242 4242:\n  ${checkout.url}\n`);

  let state = await provider.getPayment({ sessionId: checkout.sessionId });
  step(state.outcome === "PENDING" && state.environment === "TEST", "before payment the provider reports it pending, in TEST");
  const deadline = Date.now() + 10 * 60_000;
  while (state.outcome === "PENDING" && Date.now() < deadline) {
    await sleep(5000);
    state = await provider.getPayment({ sessionId: checkout.sessionId });
  }
  step(state.outcome === "SUCCEEDED", "payment confirmed by the provider's own record", state.providerStatus);
  step(state.amountCents === amountCents && state.currency === "USD", "the paid amount and currency equal what was requested", `${state.amountCents} ${state.currency}`);
  if (state.outcome === "SUCCEEDED" && wantRefund && state.paymentRef) {
    const refund = await provider.refundPayment({ paymentRef: state.paymentRef, amountCents, description: "Brohda test proof refund" });
    step(refund.status !== "failed", "TEST refund accepted by the provider", refund.status);
    const again = await provider.refundPayment({ paymentRef: state.paymentRef, amountCents, description: "duplicate" }).then(() => "accepted", () => "refused");
    step(again === "refused", "a duplicate full refund is refused by the provider", again);
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
