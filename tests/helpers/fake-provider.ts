import { PaymentProviderError, type CommercialPaymentProvider, type NormalizedOutcome, type ProviderCapabilities, type WebhookParse } from "@/lib/payments/types";

/**
 * A second, FAKE payment provider that exists only in tests. It is installed through the same registry production uses (registerTestAdapter) and is selected through the same
 * platform setting a Super Admin edits — which is the whole point: switching providers needs configuration, never a source edit. Nothing here resembles any real provider.
 */
export class FakeProvider implements CommercialPaymentProvider {
  readonly key = "TEST_PROVIDER";
  readonly label = "Test Provider";
  capabilities: ProviderCapabilities = { supportsCheckout: true, supportsRefund: true, supportsPartialRefund: false, supportsReconciliation: true, supportsRefundWebhook: true };
  configured = true;
  readonly secret = "fake-webhook-secret";
  sessions = new Map<string, { outcome: NormalizedOutcome; amountCents: number; currency: string }>();
  calls: string[] = [];
  private n = 0;
  private readonly ns = Math.random().toString(36).slice(2, 8);

  availability() {
    return this.configured ? ({ state: "test", environment: "TEST" } as const) : ({ state: "unavailable", reason: "Test Provider credentials are missing." } as const);
  }
  async createPayment(input: { attemptId: string; amountCents: number; currency: string; successUrl: string }) {
    this.calls.push("createPayment");
    const sessionId = `fake_${this.ns}_${++this.n}`;
    this.sessions.set(sessionId, { outcome: "PENDING", amountCents: input.amountCents, currency: input.currency });
    return { sessionId, url: `https://fake.test/pay/${sessionId}`, providerStatus: "open" };
  }
  async getPayment(ref: { sessionId?: string | null }) {
    this.calls.push("getPayment");
    const s = ref.sessionId ? this.sessions.get(ref.sessionId) : undefined;
    if (!s) throw new PaymentProviderError(404, "not_found", "unknown session");
    return { outcome: s.outcome, providerStatus: s.outcome.toLowerCase(), sessionId: ref.sessionId ?? null, paymentRef: s.outcome === "SUCCEEDED" ? `pay_${ref.sessionId}` : null, amountCents: s.amountCents, currency: s.currency, environment: "TEST" as const };
  }
  async refundPayment() {
    this.calls.push("refundPayment");
    return { refundId: `refund_${this.ns}_${++this.n}`, status: "succeeded" as const, failureCode: null };
  }
  async getRefund(refundId: string) {
    return { refundId, status: "succeeded" as const, failureCode: null };
  }
  settle(sessionId: string, outcome: NormalizedOutcome) {
    this.sessions.get(sessionId)!.outcome = outcome;
  }
  parseWebhook(headers: Headers, rawBody: string): WebhookParse {
    if (!this.configured) return { ok: false, status: 503 };
    if (headers.get("x-fake-secret") !== this.secret) return { ok: false, status: 401 };
    const body = JSON.parse(rawBody) as { sessionId: string; outcome: NormalizedOutcome };
    return { ok: true, event: { provider: this.key, environment: "TEST", dedupKey: `${body.sessionId}:${body.outcome}`, eventType: `fake.${body.outcome.toLowerCase()}`, attemptId: null, sessionId: body.sessionId, paymentRef: null, outcome: body.outcome, amountCents: null, currency: null, providerStatus: body.outcome.toLowerCase(), failureCode: null } };
  }
}
