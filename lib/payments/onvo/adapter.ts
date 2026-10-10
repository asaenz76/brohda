import "server-only";
import { fromProviderAmount, isProviderSupportedCurrency, toProviderAmount } from "../amount";
import { onvoAvailability, resolveOnvoConfig } from "../config";
import type { CommercialPaymentProvider, NormalizedOutcome, PaymentCheckout, ProviderAvailability, ProviderPaymentState, ProviderRefundState, WebhookParse } from "../types";
import { OnvoClient, OnvoError, type Fetcher, type OnvoPaymentIntent } from "./client";
import { ATTEMPT_METADATA_KEY, parseOnvoWebhook } from "./webhook";

// The ONLY file that speaks ONVO's vocabulary. Everything it returns is in Brohda's words (see ../types), so ONVO statuses never leak into the sponsorship domain.
const modeToEnv = (mode: unknown): "TEST" | "LIVE" | null => (mode === "test" ? "TEST" : mode === "live" ? "LIVE" : null);

function outcomeFromIntent(pi: OnvoPaymentIntent): NormalizedOutcome {
  if (pi.status === "succeeded") return "SUCCEEDED";
  if (pi.status === "failed") return "FAILED";
  return "PENDING"; // pending / processing / requires_* : the customer may still complete it inside Checkout
}

export class OnvoProvider implements CommercialPaymentProvider {
  readonly name = "ONVO" as const;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetcher?: Fetcher,
  ) {}

  availability(): ProviderAvailability {
    return onvoAvailability(this.env);
  }

  private client(): OnvoClient {
    const resolved = resolveOnvoConfig(this.env);
    if (!resolved.ok) throw new OnvoError(null, "unavailable", `ONVO unavailable: ${resolved.reason}`);
    return new OnvoClient(resolved.config, this.fetcher);
  }

  async createPayment(input: { attemptId: string; sponsorshipId: string; amountCents: number; currency: string; description: string; customerEmail: string | null; successUrl: string; cancelUrl: string }): Promise<PaymentCheckout> {
    const resolved = resolveOnvoConfig(this.env);
    if (!resolved.ok) throw new OnvoError(null, "unavailable", `ONVO unavailable: ${resolved.reason}`);
    const session = await this.client().createCheckoutSession({
      unitAmount: toProviderAmount(input.amountCents, input.currency),
      currency: input.currency,
      description: input.description.slice(0, 200),
      customerEmail: input.customerEmail,
      redirectUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { [ATTEMPT_METADATA_KEY]: input.attemptId, brohdaSponsorshipId: input.sponsorshipId, brohdaEnvironment: resolved.config.environment },
    });
    if (!session.id || !session.url) throw new OnvoError(null, "bad_response", "ONVO returned a checkout session without an id or url");
    return { sessionId: session.id, url: session.url, providerStatus: session.status ?? "open" };
  }

  async getPayment(ref: { sessionId?: string | null; paymentRef?: string | null }): Promise<ProviderPaymentState> {
    const client = this.client();
    const sessionId = ref.sessionId ?? null;
    let paymentRef = ref.paymentRef ?? null;
    let environment: "TEST" | "LIVE" | null = null;
    if (sessionId) {
      const session = await client.getCheckoutSession(sessionId);
      environment = modeToEnv(session.mode);
      if (session.status === "expired") return { outcome: "EXPIRED", providerStatus: "expired", sessionId, paymentRef: session.paymentIntentId ?? paymentRef, amountCents: null, currency: null, environment };
      paymentRef = session.paymentIntentId ?? paymentRef;
      const paid = session.paymentStatus === "paid" || session.status === "complete";
      if (!paid || !paymentRef) return { outcome: "PENDING", providerStatus: session.paymentStatus ?? session.status ?? "open", sessionId, paymentRef, amountCents: null, currency: null, environment };
    }
    if (!paymentRef) throw new OnvoError(null, "no_reference", "nothing to look up");
    // The amount and currency Brohda records come from the provider's OWN payment intent, never from the browser or the webhook body.
    const pi = await client.getPaymentIntent(paymentRef);
    const currency = pi.currency ?? null;
    return {
      outcome: outcomeFromIntent(pi),
      providerStatus: pi.status,
      sessionId,
      paymentRef,
      amountCents: currency && isProviderSupportedCurrency(currency) ? fromProviderAmount(pi.amount, currency) : null,
      currency,
      environment: modeToEnv(pi.mode) ?? environment,
    };
  }

  async refundPayment(input: { paymentRef: string; amountCents: number; description: string }): Promise<ProviderRefundState> {
    const refund = await this.client().createRefund({ paymentIntentId: input.paymentRef, amount: input.amountCents, description: input.description.slice(0, 200) });
    return normalizeRefund(refund.id, refund.status);
  }

  async getRefund(refundId: string): Promise<ProviderRefundState> {
    const refund = await this.client().getRefund(refundId);
    return normalizeRefund(refund.id, refund.status);
  }

  parseWebhook(headers: Headers, rawBody: string): WebhookParse {
    const resolved = resolveOnvoConfig(this.env);
    if (!resolved.ok) return { ok: false, status: 503 }; // not configured: the endpoint behaves as if it were not there
    return parseOnvoWebhook(headers, rawBody, resolved.config.webhookSecret, resolved.config.environment);
  }
}

function normalizeRefund(id: string, status: string): ProviderRefundState {
  if (status === "succeeded") return { refundId: id, status: "succeeded", failureCode: null };
  if (status === "failed") return { refundId: id, status: "failed", failureCode: "provider_refund_failed" };
  return { refundId: id, status: "pending", failureCode: null };
}
